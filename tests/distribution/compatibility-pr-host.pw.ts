import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('independent PR page and GitHub provider preserve scope and recover a lost review response without duplicate publication', async ({ page, request }, testInfo) => {
  test.setTimeout(150_000); page.setDefaultTimeout(10_000);
  const host = await fixture();
  const stateFile = join(host.cwd, 'github-reviews.json');
  const head = 'a'.repeat(40); const base = 'b'.repeat(40);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('deny-pr-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/compat-pr/panel.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await writeFile(stateFile, JSON.stringify({ posts: 0, reviews: [
      ['APPROVED', 'reviewer-a'], ['APPROVED', 'reviewer-b'], ['CHANGES_REQUESTED', 'reviewer-c'], ['COMMENTED', 'reviewer-d'],
    ].map(([state, login], index) => ({ id: index + 1, user: { login }, state, body: state === 'CHANGES_REQUESTED' ? 'Preserve the retry request. Literal <img src=x> stays text.' : '', html_url: `https://github.com/org/b/pull/42#pullrequestreview-${index + 1}`, commit_id: head, submitted_at: '2026-09-20T11:00:00.000Z' })) }));
    const preload = join(host.root, 'github.mjs');
    await writeFile(preload, `import { readFileSync, writeFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.github.com') {
    if (['127.0.0.1','localhost'].includes(url.hostname)) return original(input, init);
    throw new Error('Unexpected external fixture request');
  }
  const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  if (url.pathname === '/user') return Response.json({login:'reviewer'});
  if (url.pathname === '/repos/org/b/pulls/42') return Response.json({number:42,title:'Independent PR package',html_url:'https://github.com/org/b/pull/42',state:'open',merged:false,draft:false,
    user:{login:'reviewer'},head:{sha:'${head}',ref:'topic'},base:{sha:'${base}',repo:{full_name:'org/b'}},updated_at:'2026-09-20T12:00:00.000Z',comments:7,requested_reviewers:[{login:'reviewer-d'}],requested_teams:[{slug:'platform'}]});
  if (url.pathname === '/repos/org/b/pulls/43') return Response.json({number:43,title:'Closed independent PR',html_url:'https://github.com/org/b/pull/43',state:'closed',merged:false,draft:false,user:{login:'reviewer'},head:{sha:'${head}',ref:'closed-topic'},base:{sha:'${base}',repo:{full_name:'org/b'}},updated_at:'2026-09-20T12:00:00.000Z',comments:0,requested_reviewers:[],requested_teams:[]});
  if (url.pathname === '/repos/org/b/commits/${head}') return Response.json({sha:'${head}',commit:{committer:{date:'2026-09-20T10:00:00.000Z'}}});
  if (url.pathname === '/repos/org/b/issues/42/comments') return Response.json([{id:70,user:{login:'reviewer-c'},body:'Feedback after current commit',created_at:'2026-09-20T12:00:00.000Z'}]);
  if (url.pathname === '/repos/org/b/pulls/42/comments') return Response.json([]);
  if (url.pathname.endsWith('/check-runs')) return Response.json({total_count:61,check_runs:Array.from({length:61},(_,index)=>({id:index+1,name:'Validation '+String(index+1).padStart(2,'0'),head_sha:'${head}',status:'completed',conclusion:'success',html_url:'https://github.com/org/b/actions/runs/'+(index+1)}))});
  if (url.pathname.endsWith('/status')) return Response.json({sha:'${head}',total_count:0,statuses:[]});
  if (url.pathname === '/repos/org/b/pulls/42/reviews') {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); state.posts++;
      const review = {id:100+state.posts,user:{login:'reviewer'},state:'COMMENTED',body:body.body,commit_id:body.commit_id,submitted_at:'2026-09-20T12:00:00.000Z'};
      state.reviews.push(review); writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state)); return Response.json(review,{status:201});
    }
    return Response.json(state.reviews);
  }
  if (url.pathname.includes('/compare/')) return Response.json({url:url.origin+url.pathname,base_commit:{sha:'${base}'},merge_base_commit:{sha:'${base}'},total_commits:1,files:[{filename:'source.ts',status:'modified',additions:1,deletions:0,patch:'+public plugin'}]});
  if (url.pathname === '/search/issues') {const items=[{number:42,title:'Independent PR package',repository_url:'https://api.github.com/repos/org/b',state:'open',created_at:'2026-09-20T12:00:00.000Z',comments:7,pull_request:{merged_at:null}},...(url.searchParams.get('q')?.includes('is:open')?[]:[{number:43,title:'Closed independent PR',repository_url:'https://api.github.com/repos/org/b',state:'closed',created_at:'2026-09-20T12:00:00.000Z',comments:0,pull_request:{merged_at:null}}])];return Response.json({total_count:items.length,incomplete_results:false,items});}
  if (url.pathname.endsWith('/pulls')) return Response.json([]);
  return new Response(null,{status:404});
};`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    host.env.GITHUB_TOKEN = 'fixture-token'; host.env.GITHUB_PR_AUTHOR = 'reviewer'; host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    await host.installAuthorPackage('plugin-sources/compat-pr', 'example.authored-pr', { buildScript: true });
    await host.installAuthorPackage('plugin-sources/github', undefined, { buildScript: true });
    await host.cli('select', 'helmsman/pr-compatibility-page', 'example.authored-pr/page');
    await host.cli('select-pull-request', 'example.github/github');
    const origin = await host.start();
    const retained: { value: { command: {requestId:string}; scopeRepo:string } | null } = { value: null };
    await page.route('**/api/pull-request-command', async route => {
      retained.value = route.request().postDataJSON();
      const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.abort('failed');
    });
    await page.goto(`${origin}/pr?repo=org/a&prRepo=org/b&pr=42&mode=rerun`);
    const pr = page.locator('.plugin-pr-compatibility');
    await expect(pr.locator('.pr-panel-title')).toHaveText('Independent PR package');
    await expect(pr.locator('.pr-panel > .pr-subpanel')).toHaveCount(4);
    expect(await pr.locator('.pr-panel').evaluate(root => ['.pr-summary', '.pr-agent-section', '.pr-diff-panel', '.pr-manual-review'].every(selector => root.querySelector(selector)?.closest('.pr-panel') === root))).toBe(true);
    expect(await pr.locator('.pr-panel').evaluate(root => [...root.querySelectorAll(':scope > .pr-subpanel')].map(node => node.classList.contains('pr-agent-section') ? 'agent' : node.classList.contains('pr-diff-panel') ? 'diff' : node.classList.contains('pr-manual-review') ? 'manual' : 'summary'))).toEqual(['summary', 'agent', 'diff', 'manual']);
    const authored = pr.locator('.pr-authored');
    await expect(authored.locator('.pr-list-row')).toHaveCount(1); await expect(authored.locator('[data-select-number="43"]')).toHaveCount(0);
    await authored.locator('[data-authored-state="all"]').click(); await expect(authored.locator('.pr-list-row')).toHaveCount(2); await expect(authored.locator('[data-authored-state="all"]')).toBeFocused(); await expect(authored).toContainText('Closed independent PR');
    await authored.locator('[data-authored-state="open"]').click(); await expect(authored.locator('.pr-list-row')).toHaveCount(1); await expect(authored.locator('[data-authored-state="open"]')).toBeFocused(); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(authored).toContainText('2 approvals');
    await expect(authored.locator('.pr-feedback-badge')).toHaveText(['Changes requested', 'New comments']);
    await expect(authored.locator('.pr-list-select')).toHaveAccessibleName(/Changes requested · New comments$/);
    await expect(authored.locator('.pr-list-stats')).not.toContainText('changes requested');
    await expect(authored).toContainText('7 discussion comments');
    await expect(page.locator('#boot')).toHaveCount(0);
    await authored.screenshot({ path: testInfo.outputPath('authored-counts-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await authored.screenshot({ path: testInfo.outputPath('authored-counts-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    for (const selector of ['.pr-summary', '.pr-agent-section', '.pr-diff-panel']) await expect(pr.locator(selector)).toHaveAttribute('open', '');
    const metadata = pr.locator('.pr-summary'); await metadata.locator(':scope > summary').focus(); await metadata.locator(':scope > summary').press('Space');
    await page.getByRole('button', { name: 'Refresh page', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(metadata).not.toHaveAttribute('open', ''); await expect(metadata.locator('.pr-summary-body')).not.toBeVisible(); await expect(metadata.locator(':scope > summary')).toBeFocused(); await metadata.locator(':scope > summary').press('Enter'); await expect(metadata.locator('.pr-summary-body')).toBeVisible();
    const approved = metadata.locator('[data-pr-disclosure$=":approved:preview"]'); await approved.locator(':scope > summary').focus(); await expect(approved.locator('.pr-stat-popup li')).toHaveText(['reviewer-a ↗', 'reviewer-b ↗']); await approved.locator(':scope > summary').press('Escape'); await expect(approved).not.toHaveAttribute('open', '');
    const requested = metadata.locator('[data-pr-disclosure$=":requested:preview"]'); await requested.locator(':scope > summary').hover(); await expect(requested.locator('.pr-stat-popup li')).toHaveText(['reviewer-d ↗', 'team:platform']); await pr.locator('.pr-panel-title').click(); await expect(requested).not.toHaveAttribute('open', '');
    const checks = metadata.locator('[data-pr-disclosure$=":checks-passed:preview"]'); await expect(checks.locator(':scope > summary')).toHaveAccessibleName('61 passed; show details'); await checks.locator(':scope > summary').focus(); await expect(checks.locator(':scope > .pr-stat-popup > ul > li')).toHaveCount(5); await checks.locator('.pr-evidence-more > summary').click(); await expect(checks).toHaveAttribute('open', ''); await expect(checks.locator('.pr-evidence-more > ul > li')).toHaveCount(56); await pr.locator('.pr-panel-title').click(); await expect(checks).not.toHaveAttribute('open', '');
    const discussions = metadata.locator('.pr-discussion'); for (const section of await discussions.all()) { await section.locator(':scope > summary').focus(); await section.locator(':scope > summary').press('Enter'); }
    await expect(metadata.locator('.pr-discussion-text')).toContainText(['Literal <img src=x>', 'Feedback after current commit']); await expect(metadata.locator('img, script')).toHaveCount(0); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(pr.locator('.pr-manual-review')).not.toHaveAttribute('open', '');
    await expect(pr.locator('.pr-slack-review')).toHaveCount(0);
    await pr.locator('.pr-manual-review > summary').click();
    await pr.locator('.pr-review-body').fill('Original review body retained across uncertainty');
    await pr.locator('.pr-rerun-feedback').fill('Independent branch feedback');
    await expect(pr.locator('.pr-comment')).toBeEnabled(); await pr.locator('.pr-comment').click();
    await expect.poll(async () => JSON.parse(await readFile(stateFile, 'utf8')).posts).toBe(1);
    await expect(pr.getByRole('button', { name: 'Check original receipt', exact: true })).toBeVisible();
    await page.unroute('**/api/pull-request-command'); await page.reload();
    await expect(pr.locator('.pr-review-body')).toHaveValue('Original review body retained across uncertainty');
    await expect(pr.locator('.pr-rerun-feedback')).toHaveValue('Independent branch feedback');
    await pr.getByRole('button', { name: 'Check original receipt', exact: true }).click();
    await expect(pr).toContainText('Review succeeded by reviewer');
    expect(JSON.parse(await readFile(stateFile, 'utf8')).posts).toBe(1);
    expect(retained.value?.scopeRepo).toBe('org/b');
    await pr.locator('[data-close-inspection]').click();
    await expect(pr.locator('.pr-review-body')).toHaveCount(0);
    await expect(pr.locator('[data-load]')).toBeEnabled();
    await pr.locator('[data-pr-compat-lookup]').fill('org/b#42');
    await pr.locator('[data-pr-compat-lookup]').press('Enter');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(pr.locator('.pr-review-body')).toHaveValue('Original review body retained across uncertainty');
    await expect(pr.locator('.pr-review-body')).toBeVisible();
    await expect(pr.locator('[data-close-inspection]')).toBeEnabled();
    await pr.locator('.pr-review-body').click();
    await page.screenshot({ path: testInfo.outputPath('authored-pr-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pr.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await pr.locator('.pr-review-body').click();
    await page.screenshot({ path: testInfo.outputPath('authored-pr-mobile.png'), fullPage: true });
    await host.cli('disable', 'example.github');
    await page.reload(); await expect(pr).toContainText('Pull request unavailable');
    const receiptUrl = `/api/pull-request-command/receipts/${retained.value!.command.requestId}?repo=org/b&scopeRepo=org/b`;
    const afterDisable = await request.get(origin + receiptUrl, { headers: {'x-helmsman-contribution':'example.authored-pr/panel'} });
    expect(await afterDisable.json()).toMatchObject({status:'succeeded',result:{repo:'org/b',number:42,actor:'reviewer'}});
    const restarted = await host.start();
    const afterRestart = await request.get(restarted + receiptUrl, { headers: {'x-helmsman-contribution':'example.authored-pr/panel'} });
    expect(await afterRestart.json()).toMatchObject({status:'succeeded'});
    expect(JSON.parse(await readFile(stateFile, 'utf8')).posts).toBe(1);
    await host.cli('disable', 'example.authored-pr'); await page.goto(`${restarted}/prs?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('independent PR page and GitHub provider preserve scope and recover a lost review response without duplicate publication', async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  const host = await fixture();
  const stateFile = join(host.cwd, 'github-reviews.json');
  const head = 'a'.repeat(40); const base = 'b'.repeat(40);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('deny-pr-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/compat-pr/panel.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await writeFile(stateFile, JSON.stringify({ posts: 0, reviews: [] }));
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
    user:{login:'reviewer'},head:{sha:'${head}',ref:'topic'},base:{sha:'${base}',repo:{full_name:'org/b'}},updated_at:'2026-09-20T12:00:00.000Z',comments:0,requested_reviewers:[],requested_teams:[]});
  if (url.pathname.endsWith('/check-runs')) return Response.json({total_count:0,check_runs:[]});
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
  if (url.pathname === '/search/issues') return Response.json({total_count:1,incomplete_results:false,items:[{number:42,title:'Independent PR package',repository_url:'https://api.github.com/repos/org/b',state:'open',created_at:'2026-09-20T12:00:00.000Z',comments:7,pull_request:{merged_at:null}}]});
  if (url.pathname.endsWith('/pulls')) return Response.json([]);
  return new Response(null,{status:404});
};`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    host.env.GITHUB_TOKEN = 'fixture-token'; host.env.GITHUB_PR_AUTHOR = 'reviewer'; host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    await host.installAuthorPackage('plugin-sources/compat-pr', 'example.authored-pr');
    await host.installAuthorPackage('plugin-sources/github', undefined, { buildScript: true });
    await host.cli('select', 'helmsman/pr-compatibility-page', 'example.authored-pr/page');
    await host.cli('select-pull-request', 'example.github/github');
    const origin = await host.start();
    let retained: { command: {requestId:string}; scopeRepo:string } | null = null;
    await page.route('**/api/pull-request-command', async route => {
      retained = route.request().postDataJSON();
      const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.abort('failed');
    });
    await page.goto(`${origin}/pr?repo=org/a&prRepo=org/b&pr=42&mode=rerun`);
    const pr = page.locator('.plugin-pr-compatibility');
    await expect(pr.locator('.pr-panel-title')).toHaveText('Independent PR package');
    const authored = pr.locator('.pr-authored');
    await expect(authored).toContainText('unknown approvals');
    await expect(authored).toContainText('unknown changes requested');
    await expect(authored).toContainText('7 discussion comments');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
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
    expect(retained?.scopeRepo).toBe('org/b');
    await pr.getByRole('button', { name: 'Hide Pull requests', exact: true }).click();
    await expect(pr.locator('.pr-review-body')).toBeHidden();
    await pr.getByRole('button', { name: 'Show Pull requests', exact: true }).click();
    await expect(pr.locator('.pr-review-body')).toHaveValue('Original review body retained across uncertainty');
    await expect(pr.locator('.pr-review-body')).toBeVisible();
    await expect(pr.getByRole('button', { name: 'Hide Pull requests', exact: true })).toBeEnabled();
    await pr.locator('.pr-review-body').click();
    await page.screenshot({ path: testInfo.outputPath('authored-pr-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pr.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await pr.locator('.pr-review-body').click();
    await page.screenshot({ path: testInfo.outputPath('authored-pr-mobile.png'), fullPage: true });
    await host.cli('disable', 'example.github');
    await page.reload(); await expect(pr).toContainText('Pull request unavailable');
    const receiptUrl = `/api/pull-request-command/receipts/${retained!.command.requestId}?repo=org/b&scopeRepo=org/b`;
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

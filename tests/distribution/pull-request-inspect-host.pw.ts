import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('copied SDK inspection exercises production GitHub projection, immutable previews, scope and cancellation', async ({ page, request }) => {
  test.setTimeout(120_000);
  const host = await fixture();
  const headSha = 'a'.repeat(40); const baseSha = 'b'.repeat(40);
  const stateFile = join(host.cwd, 'github-fixture.json'); const callsFile = join(host.cwd, 'github-calls.log');
  let state = { headSha, partial: false, delay: false };
  const saveState = async (change: Partial<typeof state>) => { state = { ...state, ...change }; await writeFile(stateFile, JSON.stringify(state)); };
  const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('prove-pr-inspection-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await saveState({});
    const preload = join(host.root, 'github-fixture.mjs');
    await writeFile(preload, `import { readFileSync, appendFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.github.com') {
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return original(input, init);
    throw new Error('Unexpected external fixture request');
  }
  const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  const log = value => appendFileSync(${JSON.stringify(callsFile)}, value + '\\n');
  log(url.pathname);
  if (url.pathname === '/repos/org/a/pulls/7') {
    if (state.delay) await new Promise((resolve, reject) => {
      const signal = init?.signal;
      const cancel = () => { clearTimeout(timer); log('aborted:' + url.pathname); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 10000);
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    });
    return Response.json({ number: 7, title: 'Independent inspection proof', html_url: 'https://github.com/org/a/pull/7', state: 'open', merged: false, draft: false,
      user: { login: 'author' }, head: { sha: state.headSha, ref: 'feature' }, base: { sha: '${baseSha}', repo: { full_name: 'org/a' } },
      updated_at: '2026-09-20T12:00:00.000Z', comments: 2, requested_reviewers: [{ login: 'reviewer' }], requested_teams: [] });
  }
  if (url.pathname.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: 1, head_sha: state.headSha, status: 'completed', conclusion: 'success' }] });
  if (url.pathname.endsWith('/status')) return Response.json({ sha: state.headSha, total_count: state.partial ? 2 : 1,
    statuses: [{ id: 2, context: 'external-ci', state: 'failure', updated_at: '2026-09-20T12:00:00.000Z' }] });
  if (url.pathname === '/repos/org/a/pulls/7/reviews') return Response.json([{ id: 3, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-09-20T12:00:00.000Z', commit_id: state.headSha }]);
  if (url.pathname.includes('/compare/')) return Response.json({ url: url.origin + url.pathname, base_commit: { sha: '${baseSha}' }, merge_base_commit: { sha: '${baseSha}' }, total_commits: 1,
    files: [{ filename: 'source.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x'.repeat(40000) }, { filename: 'image.png', status: 'added', additions: 0, deletions: 0 }] });
  if (url.pathname.startsWith('/search/')) return Response.json({ total_count: 0, incomplete_results: false, items: [] });
  if (url.pathname.endsWith('/pulls')) return Response.json([]);
  return new Response(null, { status: 404 });
};
`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    host.env.GITHUB_TOKEN = 'fixture-token'; host.env.GITHUB_PR_AUTHOR = 'reviewer';
    host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    const author = join(host.app, 'plugin-sources/pr-inspect-proof'); await mkdir(author);
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmitOnError: true }, include: ['page.ts'] }));
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 2, sdkVersion: 1, id: 'example.pr-inspect-proof', version: '1.0.0',
        pages: [{ id: 'page', title: 'Independent PR inspection', slots: [], panes: [], requires: [{ id: 'helmsman/pull-request-inspect', version: 1 }] }], panels: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { page: 'page.js' }, panelEntries: {} }));
    await writeFile(join(author, 'page.ts'), `import type { PluginPageModule, PullRequestInspectTargetV1 } from '@helmsman/plugin-sdk';
const page: PluginPageModule = { mount(container, context) {
  const inspect = context.services?.pullRequestInspect;
  if (!inspect) throw new Error('Inspection unavailable');
  const heading = document.createElement('h1'); heading.textContent = 'Independent PR inspection';
  const result = document.createElement('pre'); result.dataset.inspection = ''; result.style.whiteSpace = 'pre-wrap';
  let target: PullRequestInspectTargetV1 | null = null; let operation = new AbortController();
  const execute = async (kind: string) => {
    operation = new AbortController(); result.textContent = 'pending';
    try {
      const value = kind === 'diff' && target ? await inspect.diff({ version: 1, target }, operation.signal)
        : await inspect.detail({ version: 1, repo: kind === 'foreign' ? 'org/b' : 'org/a', number: 7 }, operation.signal);
      if (value.status === 'available' && 'checks' in value.value) target = value.value.target;
      result.textContent = JSON.stringify(value);
    } catch (error) { result.textContent = error instanceof Error ? error.name : 'error'; }
  };
  const buttons = ['detail', 'diff', 'foreign', 'cancel'].map(kind => {
    const button = document.createElement('button'); button.textContent = kind;
    button.onclick = () => { if (kind === 'cancel') operation.abort(); else void execute(kind); }; return button;
  });
  container.replaceChildren(heading, ...buttons, result);
  return { update() {}, dispose() { operation.abort(); container.replaceChildren(); } };
} }; export default page;
`);
    await host.installAuthorPackage('plugin-sources/pr-inspect-proof');
    const origin = await host.start();
    await page.goto(`${origin}/plugins/example.pr-inspect-proof/page?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Independent PR inspection', exact: true })).toBeVisible();
    const result = page.locator('[data-inspection]');
    const execute = async (name: string) => { await page.getByRole('button', { name, exact: true }).click(); await expect(result).toContainText('"status":'); return JSON.parse(await result.innerText()); };
    expect(await execute('detail')).toMatchObject({ status: 'available', value: { target: { repo: 'org/a', number: 7, headSha, baseSha }, isOwnPr: false,
      checks: { quality: 'complete', passed: 1, failed: 1, pending: 0 }, reviews: { quality: 'complete', viewerReview: 'APPROVED' } } });
    const diff = await execute('diff');
    expect(diff).toMatchObject({ status: 'available', value: { coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false,
      files: [{ filename: 'source.ts', patchStatus: 'truncated' }, { filename: 'image.png', patchStatus: 'unavailable', patch: null }] } });
    expect(diff.value.files[0].patch).toHaveLength(32 * 1024);
    const beforeForeign = (await calls()).filter(value => value.startsWith('/repos/org/b/')).length;
    expect(await execute('foreign')).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect((await calls()).filter(value => value.startsWith('/repos/org/b/'))).toHaveLength(beforeForeign);
    const denied = await request.get(`${origin}/api/pull-request-inspect/detail?repo=private%2Funknown&number=7`);
    expect(denied.status()).toBe(403); expect((await calls()).some(value => value.includes('private/unknown'))).toBe(false);
    await saveState({ partial: true });
    expect(await execute('detail')).toMatchObject({ status: 'available', value: { checks: { quality: 'partial', passed: null, failed: null, pending: null } } });
    await saveState({ headSha: 'c'.repeat(40) });
    expect(await execute('diff')).toEqual({ status: 'unavailable', reason: 'head-changed' });
    await saveState({ delay: true });
    const beforeSlow = (await calls()).filter(value => value === '/repos/org/a/pulls/7').length;
    await page.getByRole('button', { name: 'detail', exact: true }).click();
    await expect.poll(async () => (await calls()).filter(value => value === '/repos/org/a/pulls/7').length).toBeGreaterThan(beforeSlow);
    await page.getByRole('button', { name: 'cancel', exact: true }).click(); await expect(result).toHaveText('AbortError');
    await expect.poll(async () => (await calls()).filter(value => value === 'aborted:/repos/org/a/pulls/7').length).toBe(1);
    const beforeScopeChange = (await calls()).filter(value => value === '/repos/org/a/pulls/7').length;
    await page.getByRole('button', { name: 'detail', exact: true }).click();
    await expect.poll(async () => (await calls()).filter(value => value === '/repos/org/a/pulls/7').length).toBeGreaterThan(beforeScopeChange);
    await page.locator('.repo-select').selectOption('org/b');
    await expect.poll(async () => (await calls()).filter(value => value === 'aborted:/repos/org/a/pulls/7').length).toBe(2);
    expect(await execute('detail')).toEqual({ status: 'unavailable', reason: 'forbidden' });
    await page.locator('.repo-select').selectOption('org/a');
    await saveState({ delay: false, partial: false }); await page.reload();
    expect(await execute('detail')).toMatchObject({ status: 'available', value: { target: { headSha: state.headSha } } });
    expect((await calls()).some(value => value === `/repos/org/a/compare/${baseSha}...${headSha}`)).toBe(true);
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

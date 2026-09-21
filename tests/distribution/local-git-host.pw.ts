import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, run, sourceRoot } from './isolated-fixture';

test('source-denied Local Git replacement preserves confirmed intent and fences undelivered controls', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const host = await fixture();
  const git = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
  const checkout = join(host.cwd, 'a');
  const errors: string[] = [];
  const caller = 'example.authored-local-git/panel';
  const headers = { 'x-helmsman-contribution': caller };
  page.on('pageerror', error => errors.push(error.message));
  const local = (...args: string[]) => run(git, ['-C', checkout, ...args], host.cwd, host.env);
  try {
    await expect(host.script('deny-local-git-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/local-git/page.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    await mkdir(checkout);
    await local('init', '-b', 'main');
    await local('config', 'user.name', 'Fixture');
    await local('config', 'user.email', 'fixture@example.invalid');
    await local('config', 'commit.gpgsign', 'false');
    await local('remote', 'add', 'origin', 'https://github.com/org/a.git');
    await local('commit', '--allow-empty', '-m', 'Isolated fixture');
    await local('branch', 'merged-topic');
    await local('branch', 'retained-topic');
    await writeFile(join(host.root, 'commands/git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '-C' || !args[1]?.startsWith(${JSON.stringify(host.cwd + '/')}) || args.includes('fetch') || args.includes('push') || args.includes('clone')) process.exit(1);
const result = spawnSync(${JSON.stringify(git)}, args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    await host.installAuthorPackage('plugin-sources/local-git', 'example.authored-local-git', { buildScript: true });
    await host.cli('select', 'helmsman/local-git-page', 'example.authored-local-git/page');
    let origin = await host.start();
    expect((await request.get(`${origin}/api/repo/local?repo=org%2Fa`)).status()).toBe(410);
    expect((await request.post(`${origin}/api/repo/local`, { data: { repo: 'org/a', action: 'refresh-remotes' } })).status()).toBe(410);
    await page.goto(`${origin}/config?repo=org/a&pane=local-git`);
    const panel = page.locator('.local-git-panel');
    await expect(panel.locator('[data-local-branch="merged-topic"]')).toBeEnabled();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(panel.locator('[data-local-branch="main"]')).toBeDisabled();
    await panel.locator('.local-git-cleanup-preview').click();
    await expect(panel.locator('.local-git-cleanup')).toContainText('merged-topic');
    await expect(panel.locator('.local-git-cleanup')).toContainText('retained-topic');
    await page.screenshot({ path: testInfo.outputPath('local-git-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('local-git-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.locator('.local-git-cleanup-cancel').click();

    let delivered: Record<string, unknown> | null = null;
    let responseLost = false;
    await page.route('**/api/local-git/control', async route => {
      delivered = route.request().postDataJSON() as Record<string, unknown>;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
      responseLost = true;
    });
    await panel.locator('[data-local-branch="merged-topic"]').click();
    await expect(panel.locator('.local-git-confirmation')).toContainText('merged-topic');
    await panel.locator('.local-git-confirm-delete').click();
    await expect.poll(async () => (await local('branch', '--list', 'merged-topic')).trim()).toBe('');
    await expect.poll(() => responseLost, { timeout: 30_000 }).toBe(true);
    await page.unroute('**/api/local-git/control');
    await page.getByRole('button', { name: 'Check original receipt', exact: true }).click();
    await expect(panel.locator('[data-local-branch="retained-topic"]')).toBeEnabled();

    let dropped: Record<string, unknown> | null = null;
    await page.route('**/api/local-git/control', async route => {
      dropped = route.request().postDataJSON() as Record<string, unknown>;
      await route.abort('failed');
    });
    await panel.locator('[data-local-branch="retained-topic"]').click();
    await panel.locator('.local-git-confirm-delete').click();
    await expect.poll(() => dropped !== null).toBe(true);
    await page.unroute('**/api/local-git/control');
    await page.getByRole('button', { name: 'Resume operations after inspection', exact: true }).click();
    await expect(panel.locator('[data-local-branch="retained-topic"]')).toBeEnabled();
    const late = await request.post(`${origin}/api/local-git/control`, { headers, data: dropped });
    expect(late.ok()).toBe(true);
    expect(await late.json()).toMatchObject({ status: 'recovery-required' });
    expect((await local('branch', '--list', 'retained-topic')).trim()).toBe('retained-topic');

    const command = (delivered as unknown as { command: { requestId: string } }).command;
    origin = await host.start();
    const receipt = await request.get(`${origin}/api/local-git/receipts/${command.requestId}?repo=org%2Fa&scopeRepo=org%2Fa`, { headers });
    expect(receipt.ok()).toBe(true);
    expect(await receipt.json()).toMatchObject({ status: 'succeeded', input: { target: { repo: 'org/a' }, operation: { branch: 'merged-topic' } } });
    await host.cli('disable', 'example.authored-local-git');
    await page.goto(`${origin}/local-git?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    expect((await local('branch', '--list', 'retained-topic')).trim()).toBe('retained-topic');
    expect(errors).toEqual([]);
  } finally { await host.close(); }
});

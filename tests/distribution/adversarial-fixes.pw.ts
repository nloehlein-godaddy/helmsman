import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fixture, run, seedBacklogLayout } from './isolated-fixture';

const distribution = process.env.HELMSMAN_ADVERSARIAL_TEST_DISTRIBUTION;

test('installed startup preserves unrelated dirty and clean registered worktrees', async ({}, testInfo) => {
  const git = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, 'git')).find(path => existsSync(path));
  if (!git) throw new Error('Git is required for the startup ownership regression');
  const host = await fixture({ distribution });
  try {
    host.env.REPO_PROJECT_MAP = 'fixture/project=TASK';
    const repo = join(host.cwd, 'project');
    await mkdir(repo, { recursive: true });
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'Isolated fixture']]) await run(git, args, repo, host.env);
    await writeFile(join(repo, 'tracked.txt'), 'base\n');
    await run(git, ['add', '.'], repo, host.env);
    await run(git, ['commit', '-m', 'fixture'], repo, host.env);
    const trees = [join(host.root, 'developer', '.worktrees', 'personal-feature'), join(repo, '.worktrees', 'unknown-dirty'), join(repo, '.worktrees', 'unknown-clean')];
    for (const [index, tree] of trees.entries()) {
      await run(git, ['worktree', 'add', '-b', `fixture-${index}`, tree], repo, host.env);
      if (index < 2) {
        await writeFile(join(tree, 'tracked.txt'), 'unsaved tracked content\n');
        await writeFile(join(tree, 'untracked.txt'), 'unique untracked content\n');
      }
    }
    await writeFile(join(host.root, 'commands', 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]!=='-C'||a[1]!==${JSON.stringify(repo)}||a[2]!=='worktree'||!['list','remove'].includes(a[3]))process.exit(1);const r=spawnSync(${JSON.stringify(git)},a,{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o755 });
    await host.start();
    for (const [index, tree] of trees.entries()) {
      expect(await readFile(join(tree, 'tracked.txt'), 'utf8')).toBe(index < 2 ? 'unsaved tracked content\n' : 'base\n');
      if (index < 2) expect(await readFile(join(tree, 'untracked.txt'), 'utf8')).toBe('unique untracked content\n');
    }
    expect(host.output()).not.toMatch(/swept \d+ orphaned worktree/);
    await testInfo.attach('startup-workspace-ownership', { contentType: 'application/json', body: JSON.stringify({ preserved: ['foreign-dirty', 'managed-unknown-dirty', 'managed-unknown-clean'] }) });
  } finally { await host.close(); }
});

test('installed server rejects browser cross-origin mutations while preserving JSON actions and signed webhook intake', async ({ page, request }, testInfo) => {
  const host = await fixture({ distribution });
  host.env.REPO_PROJECT_MAP = 'fixture/project=TASK';
  host.env.HELMSMAN_WEBHOOK_SECRET = 'isolated-adversarial-browser-fixture-secret';
  host.env.HELMSMAN_WEBHOOK_ROUTES = '[]';
  const attacker = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Foreign origin fixture</title>'); });
  try {
    const origin = await host.start();
    await new Promise<void>((resolve, reject) => { attacker.once('error', reject); attacker.listen(0, '127.0.0.1', resolve); });
    const address = attacker.address();
    if (!address || typeof address === 'string') throw new Error('Foreign origin fixture has no address');
    const foreignOrigin = `http://127.0.0.1:${address.port}`;
    const path = '/api/repos/fixture%2Fproject/auto-claim';
    const before = await (await request.get(`${origin}/api/agents`)).json();
    expect(before.autoClaim).toEqual([]);
    await page.goto(foreignOrigin);
    const rejected = page.waitForResponse(response => response.url() === `${origin}${path}` && response.request().method() === 'POST');
    const opaque = await page.evaluate(async ({ origin, path }) => {
      const response = await fetch(`${origin}${path}`, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ enabled: true }) });
      return { type: response.type, status: response.status };
    }, { origin, path });
    expect(opaque).toEqual({ type: 'opaque', status: 0 });
    expect((await rejected).status()).toBe(403);
    expect((await (await request.get(`${origin}/api/agents`)).json()).autoClaim).toEqual([]);
    const foreignJson = await request.post(`${origin}${path}`, { headers: { Origin: foreignOrigin }, data: { enabled: true } });
    expect(foreignJson.status()).toBe(403);
    await page.goto(`${origin}/helm?repo=fixture/project`);
    await expect(page.locator('#boot')).toHaveCount(0);
    await expect(page.locator('.plugin-helm')).toBeVisible();
    const sameOrigin = await page.evaluate(async path => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
      return { status: response.status, body: await response.json() };
    }, path);
    expect(sameOrigin.status).toBe(200);
    expect((await (await request.get(`${origin}/api/agents`)).json()).autoClaim).toEqual(['fixture/project']);
    const malformed = await page.evaluate(async path => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
      return { status: response.status, body: await response.json() };
    }, path);
    expect(malformed).toEqual({ status: 400, body: { error: 'Invalid JSON request body' } });
    const invalid = await request.post(`${origin}${path}`, { data: { enabled: 'false' } });
    expect(invalid.status()).toBe(400);
    expect((await (await request.get(`${origin}/api/agents`)).json()).autoClaim).toEqual(['fixture/project']);
    const actions = await page.evaluate(async () => {
      const results = [];
      for (const action of ['stop', 'retry']) {
        const response = await fetch(`/api/agents/nonexistent-fixture-run/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        results.push({ action, status: response.status, body: await response.json() });
      }
      return results;
    });
    expect(actions).toEqual([
      { action: 'stop', status: 200, body: { stopped: false } },
      { action: 'retry', status: 404, body: { error: 'Voyage not found.' } },
    ]);
    const unsigned = await request.post(`${origin}/api/webhooks/github`, { headers: { Origin: foreignOrigin, 'Content-Type': 'text/plain', 'x-github-event': 'ping', 'x-github-delivery': 'unsigned-fixture' }, data: '{}' });
    expect(unsigned.status()).toBe(401);
    expect(await unsigned.json()).toEqual({ error: 'Invalid webhook signature' });
    const signature = createHmac('sha256', host.env.HELMSMAN_WEBHOOK_SECRET!).update('{}').digest('hex');
    const signed = await request.post(`${origin}/api/webhooks/github`, { headers: { Origin: foreignOrigin, 'Content-Type': 'text/plain', 'x-github-event': 'ping', 'x-github-delivery': 'signed-fixture', 'x-hub-signature-256': `sha256=${signature}` }, data: '{}' });
    expect(signed.status()).toBe(202);
    expect(await signed.json()).toMatchObject({ ignored: true, runId: null });
    await testInfo.attach('mutation-boundary-evidence', { contentType: 'application/json', body: JSON.stringify({ foreignOrigin, origin, opaque, rejectedStatus: 403, sameOrigin, malformed, invalidStatus: invalid.status(), actions, unsignedWebhookStatus: unsigned.status(), signedWebhookStatus: signed.status() }, null, 2) });
  } finally {
    await Promise.all([host.close(), new Promise<void>((resolve, reject) => attacker.close(error => error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()))]);
  }
});

test('installed duplicate panel controls and same-key run tabs retain distinguishable accessible identities', async ({ page }, testInfo) => {
  const host = await fixture({ distribution });
  host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const firstId = 'repeated-shared-prefix-that-cannot-fit-on-a-single-tab-line-first';
    const secondId = 'repeated-shared-prefix-that-cannot-fit-on-a-single-tab-line-second';
    const dbUrl = pathToFileURL(join(host.app, 'server/helmsman/db.js')).href;
    await host.script('seed-adversarial-run-identities.mjs', `import { openDb } from ${JSON.stringify(dbUrl)};
      const db = openDb(process.env.HELMSMAN_DB); try {
        for (const [id, attempt] of ${JSON.stringify([[firstId, 2], [secondId, 3]])}) {
          db.insertRun({ id, repo: 'org/a', ticketId: 'TASK-1', adapter: 'codex', status: 'succeeded', attempt, prNumber: null, startedAt: '2026-09-20T12:00:00.000Z', endedAt: '2026-09-20T13:00:00.000Z', costUsd: null, worktreePath: null });
          db.appendEvent(id, 'log', 'Owned log for ' + id, '2026-09-20T12:00:00.000Z');
        }
      } finally { db.close(); }`);
    await seedBacklogLayout(page);
    const origin = await host.start();
    await page.goto(`${origin}/helm?repo=org/a`);
    await expect(page.locator('#boot')).toHaveCount(0);
    const helm = page.locator('.plugin-helm');
    await expect(helm).toBeVisible();
    await helm.locator('[data-helm-focus="page:edit"]').click();
    const groups = helm.locator('.helm-config-row[role="group"]');
    await expect(groups).toHaveCount(1);
    const original = await groups.first().getAttribute('aria-label');
    expect(original).toBeTruthy();
    await helm.getByRole('button', { name: `Duplicate · ${original}`, exact: true }).click();
    await expect(groups).toHaveCount(2);
    const identities = await groups.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
    expect(new Set(identities).size).toBe(2);
    const duplicate = identities.find(identity => identity !== original);
    expect(duplicate).toBeTruthy();
    for (const identity of identities) {
      await expect(helm.getByRole('group', { name: identity!, exact: true })).toBeVisible();
      for (const action of ['Remove', 'Duplicate', 'Hide', 'Move up']) await expect(helm.getByRole('button', { name: `${action} · ${identity}`, exact: true })).toBeVisible();
    }
    await testInfo.attach('duplicate-panel-accessibility', { contentType: 'text/plain', body: await helm.ariaSnapshot() });
    await page.screenshot({ path: testInfo.outputPath('duplicate-panel-controls.png') });
    await helm.getByRole('button', { name: `Remove · ${duplicate}`, exact: true }).click();
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAttribute('aria-label', original!);
    await page.reload();
    await expect(helm).toBeVisible();
    await helm.locator('[data-helm-focus="page:edit"]').click();
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAttribute('aria-label', original!);
    await page.goto(`${origin}/run-history?repo=org/a`);
    const history = page.locator('[data-plugin-page="helmsman.run-history/page"]');
    await expect(history.getByRole('heading', { name: 'Voyage history', exact: true })).toBeVisible();
    const first = `TASK-1 · org/a · ${firstId} · Attempt 2`;
    const second = `TASK-1 · org/a · ${secondId} · Attempt 3`;
    await history.getByRole('button', { name: first, exact: true }).click();
    const viewer = page.locator('.plugin-auxiliary-slot [data-plugin-page="helmsman.run-viewer/page"]');
    await expect(viewer.locator('.run-log')).toContainText(`Owned log for ${firstId}`);
    await history.getByRole('button', { name: second, exact: true }).click();
    await expect(viewer.getByRole('tab', { name: second, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(viewer.getByRole('tab', { name: first, exact: true })).toBeVisible();
    await expect(viewer.locator('.run-log')).toContainText(`Owned log for ${secondId}`);
    await viewer.getByRole('tab', { name: second, exact: true }).press('ArrowLeft');
    await expect(viewer.getByRole('tab', { name: first, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(viewer.locator('.run-log')).toContainText(`Owned log for ${firstId}`);
    await testInfo.attach('same-key-run-accessibility', { contentType: 'text/plain', body: await viewer.ariaSnapshot() });
    await viewer.getByRole('tab', { name: first, exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await expect(viewer.getByRole('tab', { name: first, exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('same-key-run-tabs-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await viewer.getByRole('tab', { name: first, exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await expect(viewer.getByRole('tab', { name: first, exact: true })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const label of [first, second]) {
      const tab = viewer.getByRole('tab', { name: label, exact: true });
      await expect(tab).toHaveCSS('white-space', 'normal');
      await expect(tab).toHaveCSS('overflow-wrap', 'anywhere');
      expect(await tab.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath('same-key-run-tabs-mobile.png') });
    expect(errors).toEqual([]);
  } finally { await host.close(); }
});

import { expect, test } from '@playwright/test';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('packaged Companion uses MCP without a browser and retains one explicitly requested Slack delivery', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture();
  const callsPath = join(host.cwd, 'slack-mcp-calls.json');
  const token = 'fixture-delegated-slack-oauth-token';
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await expect(host.script('deny-companion-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/slack-companion/provider.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await writeFile(callsPath, '[]');
    const preload = join(host.root, 'companion-http-fixture.mjs');
    await writeFile(preload, `import { readFileSync, writeFileSync } from 'node:fs';
const original = globalThis.fetch;
const callsPath = ${JSON.stringify(callsPath)};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return original(input, init);
  if (url.href === 'https://mcp-slack.goarena.gdcorp.tools/mcp') {
    if (init?.method !== 'POST' || new Headers(init.headers).get('authorization') !== 'Bearer ' + process.env.SLACK_MCP_TOKEN) throw new Error('Unexpected MCP authorization or method');
    const body = JSON.parse(init.body);
    const calls = JSON.parse(readFileSync(callsPath, 'utf8'));
    calls.push(body); writeFileSync(callsPath, JSON.stringify(calls));
    const reply = result => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slack-fixture', version: '1' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method !== 'tools/call' || body.params?.arguments?.team_id !== 'T123') throw new Error('Unexpected MCP request');
    const { name, arguments: args } = body.params;
    const tool = value => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    if (name === 'get_channel_info' && ['C456', 'G789'].includes(args.channel_id)) return tool({ id: args.channel_id, name: 'reviews', is_archived: false, is_im: false, is_mpim: false, context_team_id: 'T123' });
    if (name === 'send_message' && args.channel_id === 'G789' && args.text === '<!subteam^S789> Could you review this PR? https://github.com/org/b/pull/42') return tool({ channel: 'G789', ts: '1790000000.123456' });
    throw new Error('Unexpected MCP tool: ' + name);
  }
  if (url.origin === 'https://api.github.com' && url.pathname === '/repos/org/b/pulls/42') return Response.json({ number: 42, state: 'open', merged: false, draft: false, user: { login: 'fixture-owner' }, head: { sha: '${'a'.repeat(40)}', ref: 'topic' }, base: { sha: '${'b'.repeat(40)}', repo: { full_name: 'org/b' } }, title: 'Companion fixture PR', html_url: 'https://github.com/org/b/pull/42', updated_at: '2026-09-21T12:00:00.000Z', comments: 0, requested_reviewers: [], requested_teams: [] });
  throw new Error('Unexpected external fixture request: ' + url.href);
};`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    Object.assign(host.env, {
      GITHUB_TOKEN: 'fixture-github-token', GITHUB_PR_AUTHOR: 'fixture-owner', REPO_PROJECT_MAP: 'org/a=TASK,org/b=OTHER',
      SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'false', SLACK_MCP_TOKEN: token,
      SLACK_CLIENT_ID: 'T123', SLACK_CHANNEL_ID: '', SLACK_CHANNEL_NAME: '', SLACK_BROWSER_SURFACE: '',
      SLACK_REVIEW_CHANNEL: 'C456', SLACK_REVIEW_MENTION: 'S456',
    });
    await cp(join(sourceRoot, 'node_modules/@types/node'), join(host.root, 'node_modules/@types/node'), { recursive: true });
    await cp(join(sourceRoot, 'node_modules/undici-types'), join(host.root, 'node_modules/undici-types'), { recursive: true });
    await host.installAuthorPackage('plugin-sources/slack-companion', undefined, { buildScript: true });
    await host.start();
    await host.stop();
    await host.cli('disable', 'helmsman.terminal-cmux');
    await host.cli('disable', 'helmsman.native-firefox');
    let origin = await host.start();
    const headers = { 'x-helmsman-contribution': 'helmsman.communication/settings' };
    const initialSettings = await request.get(`${origin}/api/communication/settings`, { headers });
    expect(initialSettings.ok()).toBe(true);
    expect(await initialSettings.json()).toMatchObject({ destination: { providerId: 'helmsman.slack-companion/slack', workspace: 'T123', channel: 'C456', mention: 'S456' } });
    await page.goto(`${origin}/communication?repo=org/a&prRepo=org/b&pr=42`);
    const settings = page.locator('.communication-settings');
    const review = page.locator('.communication-request');
    await expect(review).toContainText('Destination: T123 · #C456 · S456');
    await expect(settings).toContainText('Companion');
    await settings.getByLabel('Review request channel', { exact: true }).fill('G789');
    await settings.getByLabel('Review group ID (Companion) or handle (browser)', { exact: true }).fill('S789');
    await settings.getByRole('button', { name: 'Save communication settings', exact: true }).click();
    await expect(settings).toContainText('Settings saved. No message was sent.');
    const calls = async (): Promise<{ method: string; params?: { name?: string; arguments?: Record<string, unknown> } }[]> => JSON.parse(await readFile(callsPath, 'utf8'));
    const sends = async () => (await calls()).filter(call => call.method === 'tools/call' && call.params?.name === 'send_message');
    expect(await sends()).toHaveLength(0);
    await review.getByRole('button', { name: 'Refresh destination and requests', exact: true }).click();
    await expect(review).toContainText('Destination: T123 · #G789 · S789');
    const submitted = page.waitForRequest(value => new URL(value.url()).pathname === '/api/communication-command' && value.method() === 'POST');
    await review.getByRole('button', { name: 'Send review request', exact: true }).click();
    const command = (await submitted).postDataJSON() as { command: { requestId: string } };
    await expect(review).toContainText('succeeded');
    expect(await sends()).toEqual([expect.objectContaining({ params: { name: 'send_message', arguments: { team_id: 'T123', channel_id: 'G789', text: '<!subteam^S789> Could you review this PR? https://github.com/org/b/pull/42' } } })]);
    expect((await calls()).filter(call => call.method === 'tools/call').every(call => ['get_channel_info', 'send_message'].includes(call.params?.name ?? ''))).toBe(true);
    await expect(review.getByRole('link', { name: 'View message' })).toHaveAttribute('href', 'https://app.slack.com/archives/G789/p1790000000123456');
    const durable = await host.script('inspect-companion-record.mjs', `import Database from ${JSON.stringify(pathToFileURL(join(host.app, 'node_modules/better-sqlite3/lib/index.js')).href)}; const db = new Database(process.env.HELMSMAN_DB, { readonly: true }); try { console.log(JSON.stringify(db.prepare('SELECT draft, receipt, status FROM operations').all().filter(row => JSON.parse(row.draft).kind === 'communication.review-request'))); } finally { db.close(); }`);
    expect(durable).not.toContain(token);
    const rows = JSON.parse(durable) as { draft: string; receipt: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    const operation = JSON.parse(rows[0]!.draft);
    expect(operation.target).not.toHaveProperty('browserTransport');
    expect(operation.target.networkTransport).toMatchObject({ kind: 'provider-network' });
    expect(operation.target.destination).toMatchObject({ providerId: 'helmsman.slack-companion/slack', channel: 'G789', mention: 'S789' });
    expect(operation.artifacts.some((artifact: { pluginId: string }) => artifact.pluginId === 'helmsman.native-firefox' || artifact.pluginId === 'helmsman.terminal-cmux')).toBe(false);
    await settings.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('slack-companion-settings-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await review.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('slack-companion-review-mobile.png') });
    origin = await host.start();
    const receipt = await request.get(`${origin}/api/communication-command/receipts/${command.command.requestId}?repo=org%2Fb`, { headers: { 'x-helmsman-contribution': 'helmsman.communication/review-request' } });
    expect(receipt.ok()).toBe(true);
    expect(await receipt.json()).toMatchObject({ status: 'succeeded', result: { destination: { channel: 'G789', mention: 'S789' } } });
    expect(await sends()).toHaveLength(1);
    expect(pageErrors).toEqual([]);
    expect(host.output()).not.toContain(token);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

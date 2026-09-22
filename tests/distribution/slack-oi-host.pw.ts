import { expect, test } from '@playwright/test';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('packaged OI uses native approvals without a browser and blocks disabled approval environments', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture();
  const callsPath = join(host.cwd, 'slack-oi-calls.json');
  const token = 'fixture-private-oi-token';
  const oauthSession = 'fixture-oi-oauth-session';
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await expect(host.script('deny-oi-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/slack-oi/provider.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await writeFile(callsPath, '[]');
    const preload = join(host.root, 'oi-http-fixture.mjs');
    await writeFile(preload, `import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const original = globalThis.fetch;
const callsPath = ${JSON.stringify(callsPath)};
const chats = new Map();
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return original(input, init);
  if (url.origin === 'https://caas.open-webui.godaddy.com') {
    if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + readFileSync(process.env.SLACK_OI_TOKEN_FILE, 'utf8').trim()) throw new Error('Unexpected OI authorization');
    if (new Headers(init?.headers).get('cookie') !== 'oauth_session_id=' + process.env.SLACK_OI_OAUTH_SESSION_ID) throw new Error('Missing OI OAuth session');
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const calls = JSON.parse(readFileSync(callsPath, 'utf8'));
    calls.push({ path: url.pathname, body }); writeFileSync(callsPath, JSON.stringify(calls));
    if (url.pathname === '/api/v1/auths/') return Response.json({ id: 'fixture-user' });
    if (url.pathname === '/api/config') return Response.json({ features: { enable_tool_permissions: process.env.OI_APPROVALS !== 'false' } });
    if (url.pathname === '/api/v1/models') return Response.json({ data: [{ id: 'godaddy-slack-companion', info: { base_model_id: 'fixture-model', meta: { capabilities: { secure_access: true }, toolIds: ['server:mcp:fb83f675-3afd-44ca-bd4b-0db75b50a4bc'] } } }] });
    if (url.pathname === '/api/v1/chats/new') {
      const id = randomUUID(); const messageId = body.chat.history.currentId;
      chats.set(id, { messageId, approved: false }); return Response.json({ id });
    }
    if (url.pathname === '/api/chat/completions') {
      const chat = chats.get(body.chat_id); const prompt = body.messages[0].content;
      const name = prompt.split('Invoke exactly one tool, ')[1].split(', with exactly')[0];
      const args = JSON.parse(prompt.split('JSON arguments: ')[1].split('. Do not invoke')[0]);
      if (!chat || body.params?.tool_approval_mode !== 'ask' || args.team_id !== 'T123') throw new Error('Unexpected OI task');
      let result;
      if (name === 'slack_get_channel_info' && ['C456', 'G789'].includes(args.channel_id)) result = { id: args.channel_id, name: 'reviews', is_archived: false, is_im: false, is_mpim: false, context_team_id: 'T123' };
      else if (name === 'slack_send_message' && args.channel_id === 'G789' && args.text === '<!subteam^S789> Could you review this PR? https://github.com/org/b/pull/42') result = { channel: 'G789', ts: '1790000000.123456' };
      else throw new Error('Unexpected OI tool: ' + name);
      Object.assign(chat, { name, args, result }); return Response.json({ status: true, task_id: randomUUID() });
    }
    if (url.pathname.startsWith('/api/tasks/chat/') && url.pathname.endsWith('/stop')) return Response.json({});
    const segments = url.pathname.split('/'); const chat = chats.get(segments[4]);
    if (chat && url.pathname.endsWith('/resolve')) {
      if (chat.approved || segments[6] !== chat.messageId || body.call_id !== 'fixture-call' || body.action !== 'approve') throw new Error('Unexpected OI approval');
      chat.approved = true; return Response.json({ status: true });
    }
    if (chat && init?.method === 'GET') {
      const output = [{ type: 'function_call', call_id: 'fixture-call', name: chat.name, arguments: JSON.stringify(chat.args), status: chat.approved ? 'completed' : 'pending' }];
      if (chat.approved) output.push({ type: 'function_call_output', call_id: 'fixture-call', status: 'completed', output: [{ type: 'input_text', text: JSON.stringify(chat.result) }] });
      return Response.json({ chat: { params: { tool_approval_mode: 'ask' }, history: { messages: { [chat.messageId]: { meta: { params: { tool_approval_mode: 'ask' } }, output } } } } });
    }
  }
  if (url.origin === 'https://api.github.com' && ['/repos/org/b/pulls/42', '/repos/org/b/pulls/43'].includes(url.pathname)) return Response.json({ number: Number(url.pathname.split('/').at(-1)), state: 'open', merged: false, draft: false, user: { login: 'fixture-owner' }, head: { sha: '${'a'.repeat(40)}', ref: 'topic' }, base: { sha: '${'b'.repeat(40)}', repo: { full_name: 'org/b' } }, title: 'OI fixture PR', html_url: 'https://github.com/org/b/pull/' + url.pathname.split('/').at(-1), updated_at: '2026-09-21T12:00:00.000Z', comments: 0, requested_reviewers: [], requested_teams: [] });
  throw new Error('Unexpected external fixture request: ' + url.href);
};`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    const tokenFile = join(host.root, 'private-oi-token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    Object.assign(host.env, {
      GITHUB_TOKEN: 'fixture-github-token', GITHUB_PR_AUTHOR: 'fixture-owner', REPO_PROJECT_MAP: 'org/a=TASK,org/b=OTHER',
      SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'false', SLACK_OI_TOKEN_FILE: tokenFile, SLACK_OI_OAUTH_SESSION_ID: oauthSession,
      SLACK_CLIENT_ID: 'T123', SLACK_CHANNEL_ID: '', SLACK_CHANNEL_NAME: '', SLACK_BROWSER_SURFACE: '',
      SLACK_REVIEW_CHANNEL: 'C456', SLACK_REVIEW_MENTION: 'S456',
    });
    await cp(join(sourceRoot, 'node_modules/@types/node'), join(host.root, 'node_modules/@types/node'), { recursive: true });
    await cp(join(sourceRoot, 'node_modules/undici-types'), join(host.root, 'node_modules/undici-types'), { recursive: true });
    await host.installAuthorPackage('plugin-sources/slack-oi', undefined, { buildScript: true });
    await host.start();
    await host.stop();
    await host.cli('disable', 'helmsman.terminal-cmux');
    await host.cli('disable', 'helmsman.native-firefox');
    await host.cli('select-communication', 'example.slack-oi/slack');
    let origin = await host.start();
    const headers = { 'x-helmsman-contribution': 'helmsman.communication/settings' };
    const initialSettings = await request.get(`${origin}/api/communication/settings`, { headers });
    expect(initialSettings.ok()).toBe(true);
    expect(await initialSettings.json()).toMatchObject({ destination: { providerId: 'example.slack-oi/slack', workspace: 'T123', channel: 'C456', mention: 'S456' } });
    await page.goto(`${origin}/communication?repo=org/a&prRepo=org/b&pr=42`);
    const settings = page.locator('.communication-settings');
    const review = page.locator('.communication-request');
    await expect(review).toContainText('Destination: T123 · #C456 · S456');
    await settings.getByLabel('Review request channel', { exact: true }).fill('G789');
    await settings.getByLabel('Review group ID (Companion) or handle (browser)', { exact: true }).fill('S789');
    await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(settings).toContainText('Settings saved. No message was sent.');
    const calls = async (): Promise<{ path: string; body?: { messages?: { content?: string }[] } }[]> => JSON.parse(await readFile(callsPath, 'utf8'));
    const sends = async () => (await calls()).filter(call => call.path === '/api/chat/completions' && call.body?.messages?.[0]?.content?.includes('slack_send_message'));
    expect(await sends()).toHaveLength(0);
    expect((await calls()).filter(call => call.path === '/api/v1/chats/new')).toHaveLength(0);
    await review.getByRole('button', { name: 'Refresh destination and requests', exact: true }).click();
    await expect(review).toContainText('Destination: T123 · #G789 · S789');
    const submitted = page.waitForRequest(value => new URL(value.url()).pathname === '/api/communication-command' && value.method() === 'POST');
    await review.getByRole('button', { name: 'Send review request', exact: true }).click();
    const command = (await submitted).postDataJSON() as { command: { requestId: string } };
    await expect(review).toContainText('succeeded');
    expect(await sends()).toHaveLength(1);
    const approvals = (await calls()).filter(call => call.path.endsWith('/resolve'));
    expect(approvals).toHaveLength(1);
    await expect(review.getByRole('link', { name: 'View message' })).toHaveAttribute('href', 'https://app.slack.com/archives/G789/p1790000000123456');
    const durable = await host.script('inspect-oi-record.mjs', `import Database from ${JSON.stringify(pathToFileURL(join(host.app, 'node_modules/better-sqlite3/lib/index.js')).href)}; const db = new Database(process.env.HELMSMAN_DB, { readonly: true }); try { console.log(JSON.stringify(db.prepare('SELECT draft, receipt, status FROM operations').all().filter(row => JSON.parse(row.draft).kind === 'communication.review-request'))); } finally { db.close(); }`);
    expect(durable).not.toContain(token);
    expect(durable).not.toContain(oauthSession);
    const rows = JSON.parse(durable) as { draft: string; receipt: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    const operation = JSON.parse(rows[0]!.draft);
    expect(operation.target).not.toHaveProperty('browserTransport');
    expect(operation.target.networkTransport).toMatchObject({ kind: 'provider-network' });
    expect(operation.target.destination).toMatchObject({ providerId: 'example.slack-oi/slack', channel: 'G789', mention: 'S789' });
    expect(operation.artifacts.some((artifact: { pluginId: string }) => artifact.pluginId === 'helmsman.native-firefox' || artifact.pluginId === 'helmsman.terminal-cmux')).toBe(false);
    await settings.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('slack-oi-settings-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await review.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('slack-oi-review-mobile.png') });
    origin = await host.start();
    const receipt = await request.get(`${origin}/api/communication-command/receipts/${command.command.requestId}?repo=org%2Fb`, { headers: { 'x-helmsman-contribution': 'helmsman.communication/review-request' } });
    expect(receipt.ok()).toBe(true);
    expect(await receipt.json()).toMatchObject({ status: 'succeeded', result: { destination: { channel: 'G789', mention: 'S789' } } });
    expect(await sends()).toHaveLength(1);
    const tasksBefore = (await calls()).filter(call => call.path === '/api/v1/chats/new').length;
    host.env.OI_APPROVALS = 'false';
    origin = await host.start();
    await page.goto(`${origin}/communication?repo=org/a&prRepo=org/b&pr=43`);
    await review.getByRole('button', { name: 'Send review request', exact: true }).click();
    await expect(review).toContainText('native tool approvals');
    await expect(review).toContainText('recovery-required');
    await expect(review).not.toContainText('Uncertain result');
    expect((await calls()).filter(call => call.path === '/api/v1/chats/new')).toHaveLength(tasksBefore);
    expect(await sends()).toHaveLength(1);
    expect(pageErrors).toEqual([]);
    expect(host.output()).not.toContain(token);
    expect(host.output()).not.toContain(oauthSession);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

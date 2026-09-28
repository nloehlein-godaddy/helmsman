import { expect, test } from '@playwright/test';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('packaged Slack OAuth connects, survives restart and disconnects without browser automation or Slack messages', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture();
  const token = 'fixture-slack-user-token';
  const callsPath = join(host.cwd, 'oauth-calls.json');
  const callbackOrigin = 'https://helmsman.example';
  const headers = { 'x-helmsman-contribution': 'helmsman.communication/settings' };
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await writeFile(callsPath, '[]');
    const preload = join(host.root, 'oauth-http-fixture.mjs');
    await writeFile(preload, `import { readFileSync, writeFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return original(input, init);
  const calls = JSON.parse(readFileSync(${JSON.stringify(callsPath)}, 'utf8'));
  calls.push(url.origin + url.pathname); writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
  if (url.href === 'https://slack.com/api/oauth.v2.access') return Response.json({ ok: true, team: { id: 'T123' }, authed_user: { id: 'U123', token_type: 'user', access_token: ${JSON.stringify(token)}, scope: 'channels:read,chat:write,search:read' } });
  if (url.href === 'https://slack.com/api/auth.test') {
    if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + ${JSON.stringify(token)}) throw new Error('Unexpected token');
    return Response.json({ ok: true, team_id: 'T123', user_id: 'U123' });
  }
  if (url.href === 'https://mcp-slack.goarena.gdcorp.tools/mcp') {
    const body = JSON.parse(init.body); const reply = result => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/call' && body.params?.name === 'get_channel_info') return reply({ content: [{ type: 'text', text: JSON.stringify({ id: body.params.arguments.channel_id, name: 'reviews', is_archived: false, context_team_id: 'T123' }) }] });
    throw new Error('Unexpected Slack tool');
  }
  throw new Error('Unexpected external request');
};`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    Object.assign(host.env, { REPO_PROJECT_MAP: 'org/a=TASK', SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'false', SLACK_CLIENT_ID: 'T123',
      SLACK_CHANNEL_ID: 'C123', SLACK_CHANNEL_NAME: 'reviews', SLACK_REVIEW_CHANNEL: 'C123', SLACK_REVIEW_MENTION: 'S123',
      SLACK_OAUTH_CLIENT_ID: 'fixture-app', SLACK_OAUTH_CLIENT_SECRET: 'fixture-app-secret',
      SLACK_OAUTH_REDIRECT_URI: `${callbackOrigin}/api/communication-connection/callback`, SLACK_OAUTH_TOKEN_FILE: join(host.root, 'credentials/slack-oauth.json'),
      SLACK_MCP_TOKEN: 'must-not-fallback' });
    await cp(join(sourceRoot, 'node_modules/@types/node'), join(host.root, 'node_modules/@types/node'), { recursive: true });
    await cp(join(sourceRoot, 'node_modules/undici-types'), join(host.root, 'node_modules/undici-types'), { recursive: true });
    await host.installAuthorPackage('plugin-sources/slack-companion', undefined, { buildScript: true });
    await host.start(); await host.stop();
    await host.cli('disable', 'helmsman.terminal-cmux'); await host.cli('disable', 'helmsman.native-firefox');
    await host.cli('select-communication', 'example.slack-companion/slack');
    let origin = await host.start();
    const before = await request.get(`${origin}/api/communication-connection`, { headers });
    expect(before.ok()).toBe(true);
    const status = await before.json(); expect(status.status).toBe('disconnected');
    const start = await request.post(`${origin}/api/communication-connection/start`, { headers: { ...headers, origin: callbackOrigin }, data: { expectedRevision: status.revision } });
    expect(start.ok()).toBe(true);
    const authorization = new URL((await start.json()).authorizationUrl);
    expect(authorization.searchParams.get('user_scope')).toBe('channels:read,chat:write,search:read');
    const state = authorization.searchParams.get('state')!;
    const callback = await request.get(`${origin}/api/communication-connection/callback?code=fixture-code&state=${state}`, {
      headers: { cookie: `helmsman_communication_oauth=${state}` }, maxRedirects: 0 });
    expect(callback.status()).toBe(303); expect(callback.headers().location).toContain('connection=connected');
    await page.goto(`${origin}/communication?repo=org/a`);
    const settings = page.locator('.communication-settings');
    await expect(settings).toContainText('Slack account connected.');
    await expect(settings.getByRole('button', { name: 'Connect Slack', exact: true })).toBeDisabled();
    await expect(settings.getByRole('link', { name: 'Helmsman at the registered HTTPS address' })).toHaveAttribute('href', `${callbackOrigin}/communication`);
    await settings.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(settings.getByRole('button', { name: 'Check connection', exact: true })).toBeEnabled();
    await settings.getByRole('heading', { name: 'Slack account', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('slack-oauth-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await settings.locator('.communication-connection').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('slack-oauth-mobile.png') });
    origin = await host.start();
    await page.goto(`${origin}/communication?repo=org/a`);
    await expect(settings).toContainText('Slack account connected.');
    await settings.getByRole('button', { name: 'Disconnect Slack', exact: true }).click();
    await expect(settings).toContainText('Connect your Slack account to use Slack MCP.');
    const after = await request.get(`${origin}/api/communication/settings`, { headers });
    expect(await after.json()).toMatchObject({ destination: null });
    expect(await readFile(host.env.SLACK_OAUTH_TOKEN_FILE!, 'utf8')).not.toContain(token);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
    expect(host.output()).not.toContain(token); expect(host.output()).not.toContain('fixture-app-secret');
    expect(pageErrors).toEqual([]);
  } finally { await host.close(); }
});

import { expect, test } from '@playwright/test';
import { fixture } from './isolated-fixture';

const githubId = 'example.github-settings';
const jiraId = 'example.jira-settings';
const githubHeaders = { 'X-Helmsman-Contribution': `${githubId}/panel` };
const jiraHeaders = { 'X-Helmsman-Contribution': `${jiraId}/panel` };

test('independent global settings preserve scope, reconcile conflicts and redact credentials through restart', async ({ page, request }) => {
  const host = await fixture();
  host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  host.env.GITHUB_REPO = 'org/a';
  host.env.GITHUB_PR_AUTHOR = 'dependabot[bot]';
  try {
    await host.installAuthorPackage('plugin-sources/github-settings', githubId);
    await host.installAuthorPackage('plugin-sources/jira-settings', jiraId);
    const origin = await host.start();
    const githubUrl = `${origin}/api/github-settings?version=1&scope=global`;
    const jiraUrl = `${origin}/api/jira-settings?version=1&scope=global`;
    const initial = await (await request.get(githubUrl, { headers: githubHeaders })).json();
    expect(initial).toMatchObject({ tokenSet: false, values: { defaultRepo: 'org/a', author: 'dependabot[bot]', reviewWatchEnabled: false } });
    await page.goto(`${origin}/plugins/${githubId}/page?repo=org/a`);
    const author = page.locator('[data-setting=author]');
    await expect(author).toHaveValue('dependabot[bot]');
    await author.fill('draft-author');
    const peer = await request.post(`${origin}/api/github-settings`, { headers: { ...githubHeaders, Origin: origin }, data: {
      version: 1, scope: 'global', namespace: initial.namespace, expectedRevision: initial.revision,
      values: { ...initial.values, author: 'peer-author' },
    } });
    expect(peer.ok()).toBe(true);
    await page.getByRole('button', { name: 'Save GitHub settings', exact: true }).click();
    await expect(page.locator('[data-status]')).toContainText('not confirmed');
    await expect(author).toHaveValue('draft-author');
    await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use latest revision and keep edits', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Use latest revision and keep edits', exact: true }).click();
    await page.getByRole('button', { name: 'Save GitHub settings', exact: true }).click();
    await expect(page.locator('[data-status]')).toContainText('saved');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await page.screenshot({ path: '/tmp/helmsman-settings-github-desktop.png', fullPage: true });

    await page.goto(`${origin}/plugins/${jiraId}/page?repo=org/a`);
    const token = page.locator('[data-token]');
    await expect(page.locator('[data-token-status]')).toHaveText('API token: not set.');
    const fakeToken = 'isolated-fake-jira-token-no-authority';
    await token.fill(fakeToken);
    let posts = 0; let responseLost = false; let responseText = '';
    await page.route('**/api/jira-settings/token', async route => {
      posts++; const response = await route.fetch(); responseText = await response.text();
      await route.abort('failed'); responseLost = true;
    });
    await page.getByRole('button', { name: 'Update Jira token', exact: true }).click();
    await expect.poll(() => responseLost).toBe(true);
    expect(responseText).not.toContain(fakeToken);
    await expect(page.locator('[data-status]')).toContainText('not confirmed');
    await expect(page.getByRole('button', { name: 'Update Jira token', exact: true })).toBeDisabled();
    await expect(token).toHaveValue(fakeToken);
    const storage = await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      const records = await Promise.all(databases.filter(db => db.name).map(db => new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(db.name!); open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const connection = open.result; const names = Array.from(connection.objectStoreNames);
          if (!names.length) { connection.close(); resolve([]); return; }
          const transaction = connection.transaction(names, 'readonly'); const values: unknown[] = [];
          for (const name of names) { const read = transaction.objectStore(name).getAll(); read.onsuccess = () => values.push(read.result); }
          transaction.oncomplete = () => { connection.close(); resolve(values); };
          transaction.onerror = () => reject(transaction.error);
        };
      })));
      return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, records });
    });
    expect(storage).not.toContain(fakeToken);
    await page.unroute('**/api/jira-settings/token');
    await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
    await expect(page.locator('[data-token-status]')).toHaveText('API token: set.');
    await expect(token).toHaveValue(fakeToken);
    await page.getByRole('button', { name: 'Discard token draft', exact: true }).click();
    expect(posts).toBe(1);
    await token.fill('second-isolated-fake-token');
    await page.getByRole('button', { name: 'Update Jira token', exact: true }).click();
    await expect(page.locator('[data-status]')).toContainText('Jira token updated');
    await expect(token).toHaveValue('');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(page.getByRole('link', { name: 'Source settings', exact: true })).toHaveAttribute('href', '/source-settings?repo=org%2Fa');
    await page.screenshot({ path: '/tmp/helmsman-settings-jira-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/helmsman-settings-jira-mobile.png', fullPage: true });
    const legacy = await request.put(`${origin}/api/config`, { headers: { Origin: origin }, data: { key: 'JIRA_API_TOKEN', value: fakeToken } });
    expect(legacy.status()).toBe(410); expect(await legacy.text()).not.toContain(fakeToken);
    const core = await request.put(`${origin}/api/config`, { headers: { Origin: origin }, data: { key: 'AUTO_CLAIM_INTERVAL_MS', value: '60000' } });
    expect(core.ok()).toBe(true); expect(await core.json()).toEqual({ ok: true });
    const beforeRestart = await (await request.get(jiraUrl, { headers: jiraHeaders })).json();
    await host.stop(); host.env.HELMSMAN_PORT = new URL(origin).port;
    await host.cli('disable', githubId); expect(await host.start()).toBe(origin);
    await page.reload(); await expect(page.locator('[data-token-status]')).toHaveText('API token: set.');
    await expect(token).toHaveValue('');
    const afterRestart = await (await request.get(jiraUrl, { headers: jiraHeaders })).json();
    expect(afterRestart).toMatchObject({ tokenSet: true, sourceConfigured: false, bootstrapEnabled: false });
    expect(afterRestart.revision).not.toBe(beforeRestart.revision);
    expect((await request.get(githubUrl, { headers: githubHeaders })).status()).toBe(403);
    expect(host.output()).not.toContain(fakeToken);
  } finally { await host.close(); }
});

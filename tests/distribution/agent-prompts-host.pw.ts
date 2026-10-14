import { expect, test } from '@playwright/test';
import { fixture } from './isolated-fixture';
import type { AgentPromptSettingsSnapshotV1 } from '../../src/plugins/agent-prompts';

const id = 'example.agent-prompts';
const headers = { 'X-Helmsman-Contribution': `${id}/panel` };

test('independent prompt package saves global roles, persists through restart and rejects stale or unauthorized updates', async ({ page, request }) => {
  test.setTimeout(150_000);
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=TASK'; host.env.GITHUB_REPO = 'org/a';
  try {
    await host.installAuthorPackage('plugin-sources/agent-prompts', id, { buildScript: true });
    let origin = await host.start(); const read = async () => {
      const response = await request.get(`${origin}/api/agent-prompts`, { headers }); expect(response.ok()).toBe(true); return await response.json() as AgentPromptSettingsSnapshotV1;
    };
    const initial = await read(); expect(initial.roles.map(role => role.id).sort()).toEqual(['branch.audit', 'branch.author', 'coding.fix', 'coding.implement', 'coding.review', 'review.pull-request'].sort());
    expect(initial.roles.every(role => role.text === role.defaultText && !role.overridden)).toBe(true);
    expect((await request.get(`${origin}/api/agent-prompts`)).status()).toBe(403);
    expect((await request.get(`${origin}/api/agent-prompts`, { headers: { 'X-Helmsman-Contribution': `${id}/page` } })).status()).toBe(403);
    expect((await request.get(`${origin}/api/agent-prompts?repo=org/a`, { headers })).status()).toBe(400);
    await page.goto(`${origin}/plugins/${id}/page?repo=org%2Fa`);
    const panel = page.locator('.agent-prompts'); const role = panel.locator('[data-role]'); const text = panel.locator('[data-text]'); const save = panel.locator('[data-save]');
    await expect(role).toHaveValue('coding.implement'); await expect(text).toHaveValue(initial.roles.find(role => role.id === 'coding.implement')!.defaultText);
    await text.fill('Independent implementation instructions'); await role.selectOption('coding.fix'); await text.fill('Independent fix draft'); await role.selectOption('coding.implement');
    const peer = await request.post(`${origin}/api/agent-prompts`, { headers: { ...headers, Origin: origin }, data: { version: 1, expectedRevision: initial.revision, roleId: 'branch.audit', text: 'Peer audit instructions' } }); expect(peer.ok()).toBe(true);
    await save.click(); await expect(panel.locator('[data-error]')).not.toHaveText(''); await expect(text).toHaveValue('Independent implementation instructions');
    await page.getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect(panel.locator('[data-rebase]')).toBeEnabled(); await panel.locator('[data-rebase]').click(); await save.click();
    await expect(panel.locator('[data-status]')).toContainText('Prompt saved'); await expect(panel.locator('[data-source]')).toHaveText('Custom prompt');
    const saved = await read(); expect(saved.roles.find(role => role.id === 'coding.implement')).toMatchObject({ text: 'Independent implementation instructions', overridden: true });
    expect(saved.roles.find(role => role.id === 'branch.audit')).toMatchObject({ text: 'Peer audit instructions', overridden: true }); expect(saved.roles.find(role => role.id === 'coding.fix')?.overridden).toBe(false);
    const stale = await request.post(`${origin}/api/agent-prompts`, { headers: { ...headers, Origin: origin }, data: { version: 1, expectedRevision: initial.revision, roleId: 'coding.implement', text: 'Stale replacement' } }); expect(stale.status()).toBe(409);
    const oversized = await request.post(`${origin}/api/agent-prompts`, { headers: { ...headers, Origin: origin }, data: { version: 1, expectedRevision: saved.revision, roleId: 'coding.fix', text: '界'.repeat(1366) } }); expect(oversized.status()).toBe(400);
    await page.locator('.repo-select').selectOption('org/b'); await expect(text).toHaveValue('Independent implementation instructions'); await role.selectOption('coding.fix'); await expect(text).toHaveValue('Independent fix draft');
    await host.stop(); host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start(); await page.reload(); await expect(text).toHaveValue('Independent fix draft');
    const restarted = await read(); expect(restarted).toEqual(saved);
    await role.selectOption('coding.implement'); await panel.locator('[data-restore]').click(); expect((await read()).roles.find(role => role.id === 'coding.implement')?.overridden).toBe(true);
    await save.click(); await expect(panel.locator('[data-status]')).toContainText('Prompt saved');
    const reset = await read(); const implemented = reset.roles.find(role => role.id === 'coding.implement'); expect(implemented?.overridden).toBe(false); expect(implemented?.text).toBe(implemented?.defaultText); expect(reset.roles.find(role => role.id === 'branch.audit')?.text).toBe('Peer audit instructions');
    await expect(page.locator('.repo-select')).toHaveValue('org/b'); await expect(panel).toContainText('Existing sessions keep their original prompts.');
    await host.stop(); await host.cli('disable', id); origin = await host.start();
    expect((await request.get(`${origin}/api/agent-prompts`, { headers })).status()).toBe(403);
  } finally { await host.close(); }
});

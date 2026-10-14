import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from '../../src/data/themeGenerator';
import type { AgentPromptSettingsSaveV1, AgentPromptSettingsSnapshotV1 } from '../../src/plugins/agent-prompts';

const roleDefinitions = [
  ['coding.implement', 'Implement a task'], ['coding.fix', 'Fix a task'], ['coding.review', 'Review an implementation'],
  ['review.pull-request', 'Review a pull request'], ['branch.author', 'Update a branch'], ['branch.audit', 'Audit a branch'],
] as const;

async function mockPrompts(page: Page) {
  let generation = 1;
  const state = { failSave: false, failRead: false, holdRead: false };
  const writes: AgentPromptSettingsSaveV1[] = []; const unexpected: string[] = []; const errors: string[] = []; const reads: string[] = []; const aborted: string[] = [];
  let releaseRead: (() => void) | null = null;
  let snapshot: AgentPromptSettingsSnapshotV1 = { version: 1, revision: generation.toString(16).padStart(64, '0'), roles: roleDefinitions.map(([id, label]) => ({
    id, label, description: `Instructions used when agents ${label.toLowerCase()}.`, providerLabel: 'Built-in workflow',
    defaultText: `You are a senior software engineer.\n${label}.\nFollow project instructions and verify the affected flow.`,
    text: `You are a senior software engineer.\n${label}.\nFollow project instructions and verify the affected flow.`, overridden: false,
  })) };
  const peerChange = () => { snapshot = { ...snapshot, revision: (++generation).toString(16).padStart(64, '0') }; };
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (new URL(request.url()).pathname === '/api/agent-prompts') aborted.push(request.failure()?.errorText ?? 'failed'); });
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/agent-prompts') {
      expect(request.headers()['x-helmsman-contribution']).toBe('helmsman.agent-prompts/panel'); expect(url.search).toBe('');
      if (request.method() === 'GET') {
        reads.push(request.url());
        if (state.holdRead) await new Promise<void>(resolve => { releaseRead = resolve; });
        return route.fulfill({ status: state.failRead ? 503 : 200, json: state.failRead ? { reason: 'service-unavailable' } : snapshot }).catch(() => {});
      }
      if (request.method() === 'POST') {
        const input = request.postDataJSON() as AgentPromptSettingsSaveV1; writes.push(input);
        if (state.failSave) return route.fulfill({ status: 503, json: { reason: 'service-unavailable' } });
        if (input.expectedRevision !== snapshot.revision) return route.fulfill({ status: 409, json: { reason: 'conflict' } });
        snapshot = { ...snapshot, revision: (++generation).toString(16).padStart(64, '0'), roles: snapshot.roles.map(role => role.id === input.roleId ? { ...role, text: input.text ?? role.defaultText, overridden: input.text !== null } : role) };
        return route.fulfill({ json: snapshot });
      }
    }
    if (request.method() !== 'GET') { unexpected.push(path); return route.abort(); }
    return route.fulfill({ json: path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.agent-prompts']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {} });
  });
  return { state, writes, unexpected, errors, reads, aborted, peerChange, release: () => { state.holdRead = false; releaseRead?.(); } };
}

for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }] as const) test.describe(`Agent prompts at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('keeps global role drafts isolated and makes saves, resets and conflict recovery explicit', async ({ page }) => {
    if (mode === 'light') await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light'), recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} } }));
    const fixture = await mockPrompts(page); await page.goto('/agent-prompts?repo=org%2Fa');
    const panel = page.locator('.agent-prompts'); const role = panel.locator('[data-role]'); const text = panel.locator('[data-text]'); const save = panel.locator('[data-save]');
    const refresh = page.getByRole('button', { name: 'Refresh page', exact: true });
    await expect(role).toHaveValue('coding.implement'); await expect(role.locator('option')).toHaveCount(6); await expect(save).toBeDisabled();
    await expect(panel).toContainText('Existing sessions keep their original prompts.'); await expect(panel.getByRole('combobox')).toHaveCount(1);
    await expectReadableSurfaces(panel, ['h2', '[data-source]', '[data-text]', '.prompt-note', '[data-save]']);
    await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`agent-prompts-${width}-${mode}.png`, { fullPage: true });
    await page.setViewportSize({ width, height: 1800 }); await expect(panel).toHaveScreenshot(`agent-prompts-panel-${width}-${mode}.png`); await page.setViewportSize({ width, height: 1100 });
    await text.fill('Implementation draft <img src=x>'); await role.selectOption('coding.fix'); await text.fill('Fix draft');
    await role.selectOption('coding.implement'); await expect(text).toHaveValue('Implementation draft <img src=x>'); await expect(panel.locator('img')).toHaveCount(0);
    await text.focus(); await text.evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(3, 9));
    await refresh.evaluate(button => (button as HTMLButtonElement).click()); await expect(text).toBeFocused(); await expect.poll(() => text.evaluate(input => [(input as HTMLTextAreaElement).selectionStart, (input as HTMLTextAreaElement).selectionEnd])).toEqual([3, 9]);
    await page.locator('.repo-select').selectOption('org/b'); await expect(text).toHaveValue('Implementation draft <img src=x>');
    await page.reload(); await expect(role).toHaveValue('coding.implement'); await expect(text).toHaveValue('Implementation draft <img src=x>');
    await save.click(); await expect(panel.locator('[data-status]')).toContainText('Prompt saved'); expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({ version: 1, roleId: 'coding.implement', text: 'Implementation draft <img src=x>' }); await expect(panel.locator('[data-source]')).toHaveText('Custom prompt');
    await role.selectOption('coding.fix'); await expect(text).toHaveValue('Fix draft'); await expect(save).toBeDisabled(); await panel.locator('[data-rebase]').click(); await expect(save).toBeEnabled();
    await panel.locator('[data-discard]').click(); await expect(text).toHaveValue(/Fix a task/);
    await role.selectOption('coding.implement'); await panel.locator('[data-restore]').click(); expect(fixture.writes).toHaveLength(1); await expect(text).toHaveValue(/Implement a task/); await save.click(); await expect(panel.locator('[data-status]')).toContainText('Prompt saved'); expect(fixture.writes[1]?.text).toBeNull();
    await text.fill('Keep this conflict draft'); fixture.peerChange(); await save.click(); await expect(panel.locator('[data-error]')).not.toHaveText(''); await expect(text).toHaveValue('Keep this conflict draft'); await expect(save).toBeDisabled();
    await refresh.click(); await expect(panel.locator('[data-conflict]')).toContainText('Saved prompts changed'); await expect(save).toBeDisabled();
    await panel.locator('[data-rebase]').click(); fixture.state.failSave = true; await save.click(); await expect(panel.locator('[data-error]')).not.toHaveText(''); await expect(text).toHaveValue('Keep this conflict draft');
    fixture.state.failSave = false; await refresh.click(); await expect(save).toBeEnabled(); await save.click(); await expect(panel.locator('[data-status]')).toContainText('Prompt saved');
    await text.fill('界'.repeat(1366)); await expect(text).toHaveAttribute('aria-invalid', 'true'); await expect(save).toBeDisabled(); await expect(panel.locator('[data-error]')).toContainText('4 KiB'); await panel.locator('[data-discard]').click();
    await panel.locator('.prompt-default > summary').focus(); await panel.locator('.prompt-default > summary').press('Space'); await expect(panel.locator('[data-default]')).toBeVisible();
    await refresh.evaluate(button => (button as HTMLButtonElement).click()); await expect(panel.locator('.prompt-default')).toHaveAttribute('open', ''); await expect(panel.locator('.prompt-default > summary')).toBeFocused();
    fixture.state.failRead = true; await refresh.click(); await expect(panel.locator('[data-error]')).not.toHaveText(''); await expect(text).toHaveValue('Keep this conflict draft'); fixture.state.failRead = false;
    fixture.state.holdRead = true; const readCount = fixture.reads.length; await refresh.click(); await expect.poll(() => fixture.reads.length).toBeGreaterThan(readCount);
    await page.evaluate(() => { history.pushState(null, '', '/config?repo=org%2Fb'); dispatchEvent(new PopStateEvent('popstate')); }); await expect.poll(() => fixture.aborted.length).toBeGreaterThan(0); fixture.release(); await expect(panel).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

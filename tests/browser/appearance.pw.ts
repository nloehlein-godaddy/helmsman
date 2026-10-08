import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) test(`custom theme and Pirate mode persist without changing scope at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(path);
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [] }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: { CUSTOM_NOTE: 'Repository pirate agent content stays mine.' }, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org%2Fa');
  const panel = page.locator('.ui-customization-panel');
  const editor = panel.locator('[data-custom-theme-editor]');
  const theme = panel.locator('.theme-select');
  const accent = editor.locator('[data-custom-theme-color="accent"]');
  const savedPalette = () => page.evaluate(() => {
    const value = localStorage.getItem('cmux.theme.custom');
    return value ? JSON.parse(value) : null;
  });
  const previewAccent = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
  await expect(editor).toBeHidden();
  await expect(theme.locator('option[value="custom"]')).toHaveCount(1);
  await theme.selectOption('custom');
  await expect(editor).toBeVisible();
  await expect(accent).toHaveAttribute('type', 'color');
  await accent.fill('#91d2ad');
  expect(await previewAccent()).toBe('#91d2ad');
  expect(await savedPalette()).toBeNull();
  await editor.getByRole('button', { name: 'Save custom theme', exact: true }).click();
  expect(await savedPalette()).toMatchObject({ version: 1, palette: { accent: '#91d2ad', mode: 'dark' } });
  await page.reload();
  await expect(theme).toHaveValue('custom');
  await expect(accent).toHaveValue('#91d2ad');
  expect(await previewAccent()).toBe('#91d2ad');
  await accent.fill('#abcdef');
  await editor.locator('[data-custom-theme-mode]').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  expect(await savedPalette()).toMatchObject({ palette: { accent: '#91d2ad', mode: 'dark' } });
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(accent).toHaveValue('#91d2ad');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await editor.getByLabel('Start from', { exact: true }).selectOption('github-light');
  await editor.getByRole('button', { name: 'Use preset', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  expect(await savedPalette()).toMatchObject({ palette: { accent: '#91d2ad', mode: 'dark' } });
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(accent).toHaveValue('#91d2ad');

  const configToggle = panel.locator('.ui-terminology-settings button[data-pirate-mode]');
  const footerToggle = page.locator('.footer-controls button[data-pirate-mode]');
  const content = page.locator('[data-key="CUSTOM_NOTE"] input');
  await expect(configToggle).toHaveAttribute('role', 'switch');
  const initiallyEnabled = await configToggle.getAttribute('aria-checked');
  await configToggle.click();
  const nowEnabled = initiallyEnabled === 'true' ? 'false' : 'true';
  await expect(configToggle).toHaveAttribute('aria-checked', nowEnabled);
  await expect(footerToggle).toHaveAttribute('aria-pressed', nowEnabled);
  await expect(configToggle).toBeFocused();
  await expect(content).toHaveValue('Repository pirate agent content stays mine.');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await footerToggle.click();
  await expect(configToggle).toHaveAttribute('aria-checked', initiallyEnabled ?? 'true');
  await expect(footerToggle).toHaveAttribute('aria-pressed', initiallyEnabled ?? 'true');
  await expect(footerToggle).toBeFocused();
  await theme.selectOption('field-guide');
  await expect(editor).toBeHidden();
  await theme.selectOption('custom');
  await expect(accent).toHaveValue('#91d2ad');
  await accent.fill('#96cad3');
  await editor.getByRole('button', { name: 'Save custom theme', exact: true }).click();
  await page.reload();
  await expect(accent).toHaveValue('#96cad3');
  expect(await savedPalette()).toMatchObject({ version: 1, palette: { accent: '#96cad3', mode: 'dark' } });
  expect(await page.evaluate(() => localStorage.getItem('cmux.theme'))).toBe('custom');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cmux.theme.custom')))).toEqual(['cmux.theme.custom']);
  await page.mouse.move(0, 0);
  await theme.scrollIntoViewIfNeeded();
  await theme.focus();
  await expect(page).toHaveScreenshot(`custom-theme-editor-${width}.png`);
  await configToggle.scrollIntoViewIfNeeded();
  await configToggle.focus();
  await expect(page).toHaveScreenshot(`custom-theme-pirate-row-${width}.png`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test('custom theme saving retains the preview when browser storage fails and supports retry', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [] }
      : path === '/api/context' ? { repos: ['org/a'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org%2Fa');
  await page.locator('.theme-select').selectOption('custom');
  const editor = page.locator('[data-custom-theme-editor]');
  await editor.locator('[data-custom-theme-color="accent"]').fill('#abcdef');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith('cmux.theme')) throw new DOMException('Browser storage disabled', 'SecurityError');
      original.call(this, key, value);
    };
    Object.assign(window, { restoreAppearanceStorage: () => { Storage.prototype.setItem = original; } });
  });
  await editor.getByRole('button', { name: 'Save custom theme', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('could not be saved');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('#abcdef');
  expect(await page.evaluate(() => localStorage.getItem('cmux.theme.custom'))).toBeNull();
  await expect(editor.getByRole('button', { name: 'Discard changes', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const restore = (window as unknown as { restoreAppearanceStorage?: () => void }).restoreAppearanceStorage;
    restore?.();
  });
  await editor.getByRole('button', { name: 'Save custom theme', exact: true }).click();
  await expect(editor.locator('[data-custom-theme-status]')).toContainText('saved in this browser');
  await expect(editor.getByRole('button', { name: 'Discard changes', exact: true })).toBeDisabled();
  await page.reload();
  await expect(editor.locator('[data-custom-theme-color="accent"]')).toHaveValue('#abcdef');
});

test('custom palette survives a theme selection storage failure without claiming the selection was saved', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [] }
      : path === '/api/context' ? { repos: ['org/a'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org%2Fa');
  const theme = page.locator('.theme-select');
  const editor = page.locator('[data-custom-theme-editor]');
  await theme.selectOption('custom');
  await editor.locator('[data-custom-theme-color="accent"]').fill('#abcdef');
  await page.evaluate(() => {
    localStorage.setItem('cmux.theme', 'field-guide');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'cmux.theme') throw new DOMException('Theme selection storage disabled', 'SecurityError');
      original.call(this, key, value);
    };
  });
  await editor.getByRole('button', { name: 'Save custom theme', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Custom palette saved');
  await expect(editor.getByRole('alert')).toContainText('selection could not be saved');
  await expect(editor.getByRole('button', { name: 'Discard changes', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('#abcdef');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cmux.theme.custom') ?? 'null'))).toMatchObject({ palette: { accent: '#abcdef' } });
  expect(await page.evaluate(() => localStorage.getItem('cmux.theme'))).toBe('field-guide');
  await page.locator('.ui-terminology-settings button[data-pirate-mode]').click();
  await expect(page.locator('#ui-theme-help')).toHaveText('Applied for this session. Browser storage is unavailable.');
  await expect(editor.getByRole('alert')).toContainText('selection could not be saved');
  await page.reload();
  await expect(theme).toHaveValue('field-guide');
  await expect(editor).toBeHidden();
  await theme.selectOption('custom');
  await expect(editor.locator('[data-custom-theme-color="accent"]')).toHaveValue('#abcdef');
  await editor.getByRole('button', { name: 'Save custom theme', exact: true }).click();
  await expect(editor.locator('[data-custom-theme-status]')).toHaveText('Custom theme saved in this browser.');
  await expect(page.locator('#ui-theme-help')).toHaveText('Applies immediately. Saved in this browser.');
  expect(await page.evaluate(() => localStorage.getItem('cmux.theme'))).toBe('custom');
  await page.reload();
  await expect(theme).toHaveValue('custom');
  await expect(editor.locator('[data-custom-theme-color="accent"]')).toHaveValue('#abcdef');
});

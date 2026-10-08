import { expect, test, type Page } from '@playwright/test';

async function customThemeContrast(page: Page) {
  return page.evaluate(() => {
    const style = (selector: string): CSSStyleDeclaration => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing ${selector}`);
      return getComputedStyle(node);
    };
    const luminance = (color: string): number => {
      const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!values || values.length !== 3) throw new Error(`Unsupported computed color ${color}`);
      const channels = values.map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
    };
    const contrast = (first: string, second: string): number => {
      const a = luminance(first); const b = luminance(second);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const button = style('[data-custom-theme-save]');
    const command = style('.config-warning .mono');
    const warning = document.querySelector('.config-warning');
    const panel = warning?.closest('.config-panel');
    if (!panel) throw new Error('Missing runtime settings panel');
    return {
      button: contrast(button.color, button.backgroundColor),
      command: contrast(command.color, getComputedStyle(panel).backgroundColor),
      buttonInk: button.color,
      buttonFill: button.backgroundColor,
      vars: Object.fromEntries(['--accent', '--on-accent', '--accent-text', '--accent-text-hover', '--secondary-text'].map(key => [key, document.documentElement.style.getPropertyValue(key)])),
    };
  });
}

for (const width of [1440, 390]) test(`custom theme and Pirate mode persist without changing scope at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const writes: string[] = [];
  const errors: string[] = [];
  const iconAsset = page.waitForResponse(response => new URL(response.url()).pathname === '/icons/pirate-mode.svg');
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
  const iconResponse = await iconAsset;
  expect(iconResponse.status()).toBe(200);
  const iconSvg = await iconResponse.text();
  expect(iconSvg).toContain('<symbol id="treasure-chest"');
  expect(iconSvg).toContain('<symbol id="briefcase"');
  const expectIcon = async (enabled: boolean) => {
    const name = enabled ? 'treasure-chest' : 'briefcase';
    const icon = configToggle.locator('svg[data-pirate-icon]');
    await expect(icon).toHaveAttribute('data-pirate-icon', name);
    await expect(icon).toHaveAttribute('fill', 'currentColor');
    await expect(icon.locator('use')).toHaveAttribute('href', `/icons/pirate-mode.svg#${name}`);
    await expect(configToggle.locator('[data-pirate-mode-state]')).toHaveText(enabled ? 'On' : 'Off');
    expect(await icon.evaluate(svg => getComputedStyle(svg).fill === getComputedStyle(svg.closest('button') ?? svg).color)).toBe(true);
    await expect.poll(() => icon.locator('use').evaluate(use => (use as SVGGraphicsElement).getBBox().width)).toBeGreaterThan(0);
  };
  const initiallyEnabled = await configToggle.getAttribute('aria-checked');
  await expectIcon(initiallyEnabled === 'true');
  await configToggle.click();
  const nowEnabled = initiallyEnabled === 'true' ? 'false' : 'true';
  await expect(configToggle).toHaveAttribute('aria-checked', nowEnabled);
  await expect(footerToggle).toHaveAttribute('aria-pressed', nowEnabled);
  await expect(configToggle).toBeFocused();
  await expectIcon(nowEnabled === 'true');
  if (width === 1440) await expect(configToggle).toHaveScreenshot('pirate-mode-off-switch.png');
  await expect(content).toHaveValue('Repository pirate agent content stays mine.');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await footerToggle.click();
  await expect(configToggle).toHaveAttribute('aria-checked', initiallyEnabled ?? 'true');
  await expect(footerToggle).toHaveAttribute('aria-pressed', initiallyEnabled ?? 'true');
  await expect(footerToggle).toBeFocused();
  await expectIcon(initiallyEnabled === 'true');
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

for (const width of [1440, 390]) test(`custom accent contrast stays readable during preview and reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
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
  const accent = editor.locator('[data-custom-theme-color="accent"]');
  const save = editor.getByRole('button', { name: 'Save custom theme', exact: true });
  await accent.fill('#44005c');
  await page.mouse.move(0, 0);
  const dark = await customThemeContrast(page);
  expect(dark.button).toBeGreaterThanOrEqual(4.5);
  expect(dark.command).toBeGreaterThanOrEqual(4.5);
  expect(dark.buttonInk).toBe('rgb(255, 255, 255)');
  expect(dark.buttonFill).toBe('rgb(68, 0, 92)');
  expect(dark.vars['--accent']).toBe('#44005c');
  expect(await page.evaluate(() => localStorage.getItem('cmux.theme.custom'))).toBeNull();
  await save.click();
  await page.reload();
  await expect(accent).toHaveValue('#44005c');
  expect((await customThemeContrast(page)).vars).toEqual(dark.vars);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cmux.theme.custom') ?? 'null'))).toMatchObject({ palette: { accent: '#44005c' } });
  await save.evaluate(button => button.scrollIntoView({ block: 'start' }));
  await save.focus();
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(`custom-theme-purple-contrast-${width}.png`);

  await editor.locator('[data-custom-theme-mode]').selectOption('light');
  const changedMode = await customThemeContrast(page);
  expect(changedMode.button).toBeGreaterThanOrEqual(4.5);
  expect(changedMode.command).toBeGreaterThanOrEqual(4.5);
  await editor.getByLabel('Start from', { exact: true }).selectOption('github-light');
  await editor.getByRole('button', { name: 'Use preset', exact: true }).click();
  await accent.fill('#ffcc00');
  await page.mouse.move(0, 0);
  const bright = await customThemeContrast(page);
  expect(bright.button).toBeGreaterThanOrEqual(4.5);
  expect(bright.command).toBeGreaterThanOrEqual(4.5);
  expect(bright.buttonInk).toBe('rgb(0, 0, 0)');
  expect(bright.buttonFill).toBe('rgb(255, 204, 0)');
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(accent).toHaveValue('#44005c');
  expect((await customThemeContrast(page)).vars).toEqual(dark.vars);
  await page.route('**/assets/*.js', route => route.abort());
  await page.reload();
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');
  const bootstrapVars = await page.evaluate(() => Object.fromEntries(['--accent', '--on-accent', '--accent-text', '--accent-text-hover', '--secondary-text'].map(key => [key, document.documentElement.style.getPropertyValue(key)])));
  expect(bootstrapVars).toEqual(dark.vars);
});

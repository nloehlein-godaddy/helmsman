import { expect, test, type Page, type Locator } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from '../../src/data/themeGenerator';

async function mockConfig(page: Page) {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const json = url.pathname === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.todos-ui']) }
      : url.pathname === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : url.pathname === '/api/config' ? { config: { CUSTOM_NOTE: 'Repository pirate agent content stays mine.' }, overridden: [] }
      : url.pathname === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : url.pathname === '/api/task-edit' ? { version: 1, repo: url.searchParams.get('repo'), sources: [] }
      : url.pathname === '/api/task-sources' ? { instances: [] } : {};
    return route.fulfill({ json });
  });
}

async function setRange(range: Locator, value: number) {
  await range.evaluate((node, value) => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Missing generator range');
    node.value = String(value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(range).toHaveValue(String(value));
}

async function storedTheme(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('cmux.theme.custom') ?? 'null'));
}

async function themeVars(page: Page) {
  return page.evaluate(() => Object.fromEntries(['--bg', '--accent', '--secondary', '--text', '--control-bg', '--input-text', '--input-placeholder', '--input-accent', '--bad', '--good', '--review', '--queued'].map(key => [key, document.documentElement.style.getPropertyValue(key)])));
}

for (const width of [1440, 390]) test(`personal theme generation, overrides and Pirate mode persist at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  const hue = editor.getByRole('slider', { name: 'Hue', exact: true });
  const saturation = editor.getByRole('slider', { name: 'Saturation', exact: true });
  const brightness = editor.getByRole('slider', { name: 'Brightness', exact: true });
  const mode = editor.getByLabel('Appearance', { exact: true });
  const harmony = editor.getByLabel('Color harmony', { exact: true });
  const save = editor.getByRole('button', { name: 'Save theme', exact: true });
  const discard = editor.getByRole('button', { name: 'Discard changes', exact: true });
  const advanced = editor.locator('details');
  const accent = editor.locator('[data-custom-theme-color="accent"]');
  await expect(editor).toBeVisible();
  await expect(page.locator('.theme-select, [data-custom-theme-preset], [data-custom-theme-use-preset]')).toHaveCount(0);
  await expect(hue).toHaveAttribute('min', '0');
  await expect(hue).toHaveAttribute('max', '360');
  for (const range of [saturation, brightness]) {
    await expect(range).toHaveAttribute('min', '0');
    await expect(range).toHaveAttribute('max', '100');
  }
  await expect(hue).toHaveValue('165');
  await expect(saturation).toHaveValue('35');
  await expect(brightness).toHaveValue('45');
  await expect(harmony).toHaveValue('analogous');
  await expect(advanced).not.toHaveAttribute('open', '');
  const defaults = await themeVars(page);
  await page.mouse.move(0, 0);
  await hue.scrollIntoViewIfNeeded();
  await hue.focus();
  await expect(page).toHaveScreenshot(`personal-theme-editor-${width}.png`);
  await setRange(hue, 275);
  await setRange(saturation, 70);
  await setRange(brightness, 60);
  await harmony.selectOption('triadic');
  expect((await themeVars(page))['--accent']).not.toBe(defaults['--accent']);
  expect(await storedTheme(page)).toBeNull();
  await editor.getByText('Advanced color overrides', { exact: true }).click();
  await expect(accent).toBeVisible();
  await expect(editor.locator('[data-custom-theme-color="bad"], [data-custom-theme-color="good"], [data-custom-theme-color="review"], [data-custom-theme-color="queued"]')).toHaveCount(0);
  await accent.fill('#44005c');
  await setRange(hue, 220);
  await expect(accent).toHaveValue('#44005c');
  expect((await themeVars(page))['--accent']).toBe('#44005c');
  await save.click();
  expect(await storedTheme(page)).toMatchObject({ version: 3, recipe: { settings: { hue: 220, saturation: 70, brightness: 60, harmony: 'triadic' }, overrides: { accent: '#44005c' } }, palette: { mode: 'dark', accent: '#44005c' } });
  await page.reload();
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(hue).toHaveValue('220');
  await expect(harmony).toHaveValue('triadic');
  await editor.getByText('Advanced color overrides', { exact: true }).click();
  await expect(accent).toHaveValue('#44005c');
  await mode.selectOption('light');
  await setRange(hue, 100);
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await discard.click();
  await expect(hue).toHaveValue('220');
  await expect(mode).toHaveValue('dark');
  await expect(accent).toHaveValue('#44005c');
  await editor.getByRole('button', { name: 'Reset overrides', exact: true }).click();
  await expect(accent).not.toHaveValue('#44005c');
  await discard.click();
  await expect(accent).toHaveValue('#44005c');
  await editor.getByRole('button', { name: 'Reset theme', exact: true }).click();
  await expect(hue).toHaveValue('165');
  await expect(saturation).toHaveValue('35');
  await expect(brightness).toHaveValue('45');
  await expect(harmony).toHaveValue('analogous');
  await expect(mode).toHaveValue('dark');
  expect(await themeVars(page)).toEqual(defaults);
  await discard.click();
  await expect(accent).toHaveValue('#44005c');
  await page.mouse.move(0, 0);
  if (width === 390) {
    await advanced.evaluate(detail => detail.scrollIntoView({ block: 'start' }));
    await accent.evaluate(input => (input as HTMLInputElement).focus({ preventScroll: true }));
  } else {
    await accent.scrollIntoViewIfNeeded();
    await accent.focus();
  }
  await expect(page).toHaveScreenshot(`personal-theme-advanced-${width}.png`);

  const configToggle = page.locator('.ui-terminology-settings button[data-pirate-mode]');
  const footerToggle = page.locator('.footer-controls button[data-pirate-mode]');
  const initial = await configToggle.getAttribute('aria-checked');
  await configToggle.click();
  await expect(configToggle).toHaveAttribute('aria-checked', initial === 'true' ? 'false' : 'true');
  await expect(configToggle).toBeFocused();
  await expect(configToggle.locator('svg')).toHaveAttribute('fill', 'currentColor');
  await expect(configToggle.locator('[data-pirate-mode-state]')).toHaveText(initial === 'true' ? 'Off' : 'On');
  await footerToggle.click();
  await expect(configToggle).toHaveAttribute('aria-checked', initial ?? 'true');
  await expect(footerToggle).toBeFocused();
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toHaveValue('Repository pirate agent content stays mine.');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await editor.getByRole('button', { name: 'Reset overrides', exact: true }).click();
  await save.click();
  expect(await storedTheme(page)).toMatchObject({ version: 3, recipe: { overrides: {} } });
  await page.reload();
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(hue).toHaveValue('220');
  await editor.getByText('Advanced color overrides', { exact: true }).click();
  await expect(accent).not.toHaveValue('#44005c');
  await editor.getByRole('button', { name: 'Reset theme', exact: true }).click();
  await save.click();
  await page.reload();
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(hue).toHaveValue('165');
  expect(await themeVars(page)).toEqual(defaults);
  expect(await storedTheme(page)).toMatchObject({ recipe: { settings: { hue: 165, saturation: 35, brightness: 45, harmony: 'analogous' }, overrides: {} }, palette: { mode: 'dark' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

for (const version of [1, 2]) test(`ignores legacy palette version ${version} and obsolete selection`, async ({ page }) => {
  const palette = generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 10 }, 'light', { accent: '#ff0000' });
  const { controlBg: _controlBg, ...oldPalette } = palette;
  await page.addInitScript(value => {
    localStorage.setItem('cmux.theme', 'github-light');
    localStorage.setItem('cmux.theme.custom', value);
  }, JSON.stringify({ version, palette: version === 1 ? oldPalette : palette }));
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  await expect(editor).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');
  await expect(editor.getByLabel('Appearance', { exact: true })).toHaveValue('dark');
  await expect(editor.getByRole('slider', { name: 'Hue', exact: true })).toHaveValue('165');
  expect((await themeVars(page))['--accent']).not.toBe('#ff0000');
});

test('theme save storage failure retains live preview and supports retry', async ({ page }) => {
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  await setRange(editor.getByRole('slider', { name: 'Hue', exact: true }), 300);
  const preview = await themeVars(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'cmux.theme.custom') throw new DOMException('Storage unavailable', 'SecurityError');
      original.call(this, key, value);
    };
    Object.assign(window, { restoreAppearanceStorage: () => { Storage.prototype.setItem = original; } });
  });
  await editor.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('could not be saved');
  expect(await themeVars(page)).toEqual(preview);
  expect(await storedTheme(page)).toBeNull();
  await expect(editor.getByRole('button', { name: 'Discard changes', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { restoreAppearanceStorage?: () => void }).restoreAppearanceStorage?.());
  await editor.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(editor.locator('[data-custom-theme-status]')).toContainText('saved in this browser');
  await page.reload();
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(editor.getByRole('slider', { name: 'Hue', exact: true })).toHaveValue('300');
});

async function inputThemeContrast(page: Page, selectors: string[]) {
  return page.evaluate(selectors => {
    const luminance = (color: string): number => {
      const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!values || values.length !== 3) throw new Error(`Unsupported computed color ${color}`);
      const channels = values.map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
    };
    const ratio = (first: string, second: string): number => {
      const a = luminance(first); const b = luminance(second);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const controls = selectors.map(selector => {
      const control = document.querySelector(selector);
      if (!control) throw new Error(`Missing ${selector}`);
      const css = getComputedStyle(control);
      const placeholder = getComputedStyle(control, '::placeholder').color;
      return { selector, ink: css.color, background: css.backgroundColor, value: ratio(css.color, css.backgroundColor),
        placeholder: ratio(placeholder, css.backgroundColor), caret: ratio(css.caretColor, css.backgroundColor) };
    });
    const root = document.documentElement;
    const page = document.querySelector('.page-content');
    if (!page) throw new Error('Missing page surface');
    const pageStyle = getComputedStyle(page);
    const save = document.querySelector('[data-custom-theme-save]');
    const saveStyle = save ? getComputedStyle(save) : undefined;
    const command = document.querySelector('.config-warning .mono');
    const panel = command?.closest('.config-panel');
    const slider = document.querySelector('[data-custom-theme-setting="hue"]');
    const sliderStyle = slider ? getComputedStyle(slider) : undefined;
    const sliderPanel = slider?.closest('.config-panel');
    return { controls, slider: slider && sliderStyle && sliderPanel ? {
        focused: slider.matches(':focus-visible'),
        outline: ratio(sliderStyle.outlineColor, getComputedStyle(sliderPanel).backgroundColor),
        accent: ratio(sliderStyle.accentColor, sliderStyle.backgroundColor),
      } : undefined, button: saveStyle ? ratio(saveStyle.color, saveStyle.backgroundColor) : undefined,
      command: command && panel ? ratio(getComputedStyle(command).color, getComputedStyle(panel).backgroundColor) : undefined,
      textAnchor: root.style.getPropertyValue('--text'),
      body: ratio(pageStyle.color, pageStyle.backgroundColor),
      vars: Object.fromEntries(['--control-bg', '--input-text', '--input-placeholder', '--text', '--text-dim', '--text-faint'].map(key => [key, root.style.getPropertyValue(key)])) };
  }, selectors);
}

for (const width of [1440, 390]) test(`input overrides preserve body, values, caret and placeholders at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  const initialText = (await themeVars(page))['--text'];
  for (const [fill, computed] of [['#ffffff', 'rgb(255, 255, 255)'], ['#000000', 'rgb(0, 0, 0)']]) {
    await editor.getByText('Advanced color overrides', { exact: true }).click();
    await editor.locator('[data-custom-theme-color="controlBg"]').fill(fill!);
    await editor.locator('[data-custom-theme-color="accent"]').fill('#44005c');
    const hue = editor.getByRole('slider', { name: 'Hue', exact: true });
    await hue.focus();
    await hue.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(hue).toBeFocused();
    const result = await inputThemeContrast(page, ['[data-key="CUSTOM_NOTE"] input', '[data-custom-theme-mode]', '[data-custom-theme-harmony]']);
    expect(result.textAnchor).toBe(initialText);
    expect(result.slider?.focused).toBe(true);
    expect(result.slider?.outline).toBeGreaterThanOrEqual(3);
    expect(result.slider?.accent).toBeGreaterThanOrEqual(3);
    expect(result.body).toBeGreaterThanOrEqual(4.5);
    for (const control of result.controls) {
      expect(control.background).toBe(computed);
      expect(control.value, control.selector).toBeGreaterThanOrEqual(4.5);
      expect(control.caret, control.selector).toBeGreaterThanOrEqual(4.5);
    }
    await editor.getByRole('button', { name: 'Save theme', exact: true }).click();
    expect(await storedTheme(page)).toMatchObject({ version: 3, recipe: { overrides: { controlBg: fill, accent: '#44005c' } }, palette: { controlBg: fill, accent: '#44005c' } });
    if (fill === '#ffffff') {
      await editor.getByText('Advanced color overrides', { exact: true }).click();
      await hue.focus();
      await hue.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`personal-theme-focus-${width}.png`);
    }
    await page.reload();
    await expect(page.locator('#boot')).toHaveCount(0);
    await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
    expect((await inputThemeContrast(page, ['[data-key="CUSTOM_NOTE"] input'])).vars).toEqual(result.vars);
    await page.goto('/todos?repo=org%2Fa');
    const search = page.getByRole('searchbox', { name: 'Search Todos', exact: true });
    await expect(search).toHaveAttribute('placeholder', 'Search Todos');
    const todos = await inputThemeContrast(page, ['.todo-list input[type="search"]', '.todo-list select']);
    for (const control of todos.controls) {
      expect(control.background).toBe(computed);
      expect(control.value, control.selector).toBeGreaterThanOrEqual(4.5);
      expect(control.placeholder, control.selector).toBeGreaterThanOrEqual(4.5);
      expect(control.caret, control.selector).toBeGreaterThanOrEqual(4.5);
    }
    await search.fill('Readable search value');
    await expect(search).toHaveValue('Readable search value');
    await page.goto('/config?repo=org%2Fa');
    await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  }
  const saved = await themeVars(page);
  await page.route('**/assets/*.js', route => route.abort());
  await page.reload();
  await expect(page.locator('#boot')).toBeVisible();
  expect(await themeVars(page)).toEqual(saved);
});

test('dark and light harmonies and range extremes retain semantic status families and contrast', async ({ page }) => {
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  for (const mode of ['dark', 'light']) for (const harmony of ['analogous', 'complementary', 'triadic']) for (const extreme of [0, 100]) {
    await editor.getByLabel('Appearance', { exact: true }).selectOption(mode);
    await editor.getByLabel('Color harmony', { exact: true }).selectOption(harmony);
    await setRange(editor.getByRole('slider', { name: 'Hue', exact: true }), extreme === 0 ? 0 : 360);
    await setRange(editor.getByRole('slider', { name: 'Saturation', exact: true }), extreme);
    await setRange(editor.getByRole('slider', { name: 'Brightness', exact: true }), extreme);
    const vars = await themeVars(page);
    const channels = (key: string) => vars[key]!.slice(1).match(/.{2}/g)?.map(channel => parseInt(channel, 16)) ?? [];
    const [badR = 0, badG = 0, badB = 0] = channels('--bad');
    const [goodR = 0, goodG = 0, goodB = 0] = channels('--good');
    const [reviewR = 0, reviewG = 0, reviewB = 0] = channels('--review');
    const [queuedR = 0, queuedG = 0, queuedB = 0] = channels('--queued');
    expect(badR).toBeGreaterThan(Math.max(badG, badB));
    expect(goodG).toBeGreaterThan(Math.max(goodR, goodB));
    expect(reviewB).toBeGreaterThan(Math.max(reviewR, reviewG));
    expect(Math.min(queuedR, queuedG)).toBeGreaterThan(queuedB);
    const result = await inputThemeContrast(page, ['[data-key="CUSTOM_NOTE"] input']);
    expect(result.body).toBeGreaterThanOrEqual(4.5);
    expect(result.button).toBeGreaterThanOrEqual(4.5);
    expect(result.command).toBeGreaterThanOrEqual(4.5);
    expect(result.controls[0]?.value).toBeGreaterThanOrEqual(4.5);
    expect(result.controls[0]?.caret).toBeGreaterThanOrEqual(4.5);
  }
});

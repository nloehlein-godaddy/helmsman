import { expect, test, type Page, type Locator } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette, THEME_HARMONIES, createThemeRecipeFromPalette } from '../../src/data/themeGenerator';

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

async function wheelPoint(wheel: Locator, hue: number, brightness: number) {
  await wheel.scrollIntoViewIfNeeded();
  const bounds = await wheel.boundingBox();
  if (!bounds) throw new Error('Missing color wheel bounds');
  const radians = hue * Math.PI / 180;
  return { x: bounds.x + bounds.width / 2 + bounds.width / 2 * (100 - brightness) / 100 * Math.cos(radians),
    y: bounds.y + bounds.height / 2 - bounds.height / 2 * (100 - brightness) / 100 * Math.sin(radians) };
}

async function selectWheel(page: Page, wheel: Locator, hue: number, brightness: number) {
  const point = await wheelPoint(wheel, hue, brightness);
  await page.mouse.click(point.x, point.y);
}

async function wheelPixels(wheel: Locator) {
  return wheel.locator('canvas').evaluate(canvas => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing wheel canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing wheel rendering context');
    return [0.5, 0.75, 0.99].map(position => Array.from(context.getImageData(Math.floor(canvas.width * position), Math.floor(canvas.height / 2), 1, 1).data));
  });
}

async function expectWheelSelection(editor: Locator, hue: number, brightness: number) {
  await expect(editor.locator('[data-custom-theme-setting="hue"]')).toHaveValue(String(hue));
  await expect(editor.locator('[data-custom-theme-setting="brightness"]')).toHaveValue(String(brightness));
  await expect(editor.locator('[data-custom-theme-wheel]')).toHaveAccessibleName(`Color wheel: hue ${hue} degrees, brightness ${brightness} percent`);
}

async function setAppearance(button: Locator, mode: 'dark' | 'light') {
  const pressed = mode === 'dark' ? 'true' : 'false';
  if (await button.getAttribute('aria-pressed') !== pressed) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', pressed);
  await expect(button.locator('use')).toHaveAttribute('href', `/icons/theme-mode.svg#${mode === 'dark' ? 'moon' : 'sun'}`);
}

async function storedTheme(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('cmux.theme.custom') ?? 'null'));
}

async function themeVars(page: Page) {
  return page.evaluate(() => Object.fromEntries(['--bg', '--accent', '--secondary', '--text', '--control-bg', '--input-text', '--input-placeholder', '--input-accent', '--bad', '--good', '--review', '--queued'].map(key => [key, document.documentElement.style.getPropertyValue(key)])));
}

for (const width of [1440, 390]) test(`color wheel drag, keyboard, rendering and saved recipe stay synchronized at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  await page.addInitScript(() => {
    const durations: number[] = [];
    let frameStarted = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => requestFrame(time => {
      frameStarted = performance.now();
      callback(time);
    });
    const putImage = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args: Parameters<typeof putImage>) {
      putImage.apply(this, args);
      if (this.canvas.matches('[data-custom-theme-wheel] canvas')) durations.push(performance.now() - frameStarted);
    };
    Object.assign(window, { themeWheelPaintDurations: durations });
  });
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  const wheel = editor.locator('[data-custom-theme-wheel]');
  const hue = editor.locator('[data-custom-theme-setting="hue"]');
  const saturation = editor.locator('[data-custom-theme-setting="saturation"]');
  const brightness = editor.locator('[data-custom-theme-setting="brightness"]');
  await expect.poll(async () => (await wheelPixels(wheel))[0]?.[3]).toBe(255);
  const pixels = await wheelPixels(wheel);
  expect(Math.min(...pixels[0]!.slice(0, 3))).toBeGreaterThan(245);
  expect(Math.max(...pixels[2]!.slice(0, 3))).toBeLessThan(5);
  await setRange(saturation, 0);
  await expect.poll(async () => {
    const middle = (await wheelPixels(wheel))[1]!.slice(0, 3);
    return Math.max(...middle) - Math.min(...middle);
  }).toBeLessThanOrEqual(1);
  await setRange(saturation, 80);
  await expect.poll(async () => {
    const middle = (await wheelPixels(wheel))[1]!.slice(0, 3);
    return Math.max(...middle) - Math.min(...middle);
  }).toBeGreaterThan(15);
  console.log(`Wheel paint ${width}px first/grayscale/saturated ms: ${JSON.stringify(await page.evaluate(() => (window as unknown as { themeWheelPaintDurations: number[] }).themeWheelPaintDurations.slice(0, 3)))}`);
  const initial = await themeVars(page);
  for (const angle of [0, 90, 180, 270, 359]) {
    await selectWheel(page, wheel, angle, 50);
    await expectWheelSelection(editor, angle, 50);
  }
  expect((await themeVars(page))['--accent']).not.toBe(initial['--accent']);
  await selectWheel(page, wheel, 0, 100);
  await expectWheelSelection(editor, 359, 100);
  const start = await wheelPoint(wheel, 0, 50);
  const outside = await wheelPoint(wheel, 0, -20);
  await wheel.evaluate(node => node.addEventListener('pointerdown', event => {
    node.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId));
  }));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  expect(await wheel.evaluate(node => node.hasPointerCapture(Number(node.getAttribute('data-test-pointer'))))).toBe(true);
  await page.mouse.move(outside.x, outside.y);
  await expectWheelSelection(editor, 0, 0);
  await page.mouse.up();
  expect(await wheel.evaluate(node => node.hasPointerCapture(Number(node.getAttribute('data-test-pointer'))))).toBe(false);
  const released = await themeVars(page);
  const center = await wheelPoint(wheel, 0, 100);
  await page.mouse.move(center.x, center.y);
  await expectWheelSelection(editor, 0, 0);
  expect(await themeVars(page)).toEqual(released);
  await setRange(hue, 90);
  await setRange(brightness, 50);
  await expectWheelSelection(editor, 90, 50);
  expect(await wheel.locator('[data-custom-theme-wheel-marker]').evaluate(marker => ({ left: (marker as HTMLElement).style.left, top: (marker as HTMLElement).style.top }))).toEqual({ left: '50%', top: '25%' });
  await setRange(hue, 0);
  await wheel.focus();
  await wheel.press('ArrowLeft');
  await expectWheelSelection(editor, 359, 50);
  await wheel.press('ArrowRight');
  await wheel.press('Shift+ArrowLeft');
  await wheel.press('ArrowUp');
  await expectWheelSelection(editor, 350, 51);
  await wheel.press('Shift+ArrowDown');
  await expectWheelSelection(editor, 350, 41);
  await expect(wheel).toBeFocused();
  await expect(saturation).toHaveValue('80');
  expect(await storedTheme(page)).toBeNull();
  await editor.getByText('Advanced color overrides', { exact: true }).click();
  await editor.locator('[data-custom-theme-color="accent"]').fill('#44005c');
  await selectWheel(page, wheel, 135, 65);
  await expectWheelSelection(editor, 135, 65);
  await expect(editor.locator('[data-custom-theme-color="accent"]')).toHaveValue('#44005c');
  await editor.getByRole('button', { name: 'Save theme', exact: true }).click();
  expect(await storedTheme(page)).toMatchObject({ recipe: { settings: { hue: 135, saturation: 80, brightness: 65 }, overrides: { accent: '#44005c' } } });
  await page.reload();
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  await expectWheelSelection(editor, 135, 65);
  await selectWheel(page, wheel, 270, 40);
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expectWheelSelection(editor, 135, 65);
  await editor.getByRole('button', { name: 'Reset theme', exact: true }).click();
  await expectWheelSelection(editor, 165, 45);
  await expect(saturation).toHaveValue('35');
  await wheel.focus();
  await wheel.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(wheel).toBeFocused();
  expect(await wheel.evaluate(node => node.matches(':focus-visible'))).toBe(true);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await wheelPixels(wheel))[0]?.[3]).toBe(255);
  await expect(page).toHaveScreenshot(`personal-theme-wheel-${width}.png`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('mobile touch wheel captures drags and pointer cancellation releases updates', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 }, hasTouch: true, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await mockConfig(page);
    await page.goto('/config?repo=org%2Fa');
    await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
    const editor = page.locator('[data-custom-theme-editor]');
    const wheel = editor.locator('[data-custom-theme-wheel]');
    await wheel.evaluate(node => node.addEventListener('pointerdown', event => {
      node.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId));
      node.setAttribute('data-test-pointer-type', (event as PointerEvent).pointerType);
    }));
    const start = await wheelPoint(wheel, 0, 50);
    const top = await wheelPoint(wheel, 90, 75);
    const client = await context.newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
    await expectWheelSelection(editor, 0, 50);
    await expect(wheel).toHaveAttribute('data-test-pointer-type', 'touch');
    expect(await wheel.evaluate(node => node.hasPointerCapture(Number(node.getAttribute('data-test-pointer'))))).toBe(true);
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...top, id: 1 }] });
    await expectWheelSelection(editor, 90, 75);
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await wheel.evaluate(node => node.hasPointerCapture(Number(node.getAttribute('data-test-pointer'))))).toBe(false);
    const canceled = await themeVars(page);
    await wheel.evaluate((node, point) => node.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: Number(node.getAttribute('data-test-pointer')), pointerType: 'touch', clientX: point.x, clientY: point.y,
    })), start);
    await expectWheelSelection(editor, 90, 75);
    expect(await themeVars(page)).toEqual(canceled);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 2 }] });
    await expectWheelSelection(editor, 0, 50);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await wheel.evaluate(node => node.hasPointerCapture(Number(node.getAttribute('data-test-pointer'))))).toBe(false);
  } finally {
    await context.close();
  }
});

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
  const mode = editor.locator('[data-custom-theme-mode]');
  const harmony = editor.getByLabel('Color harmony', { exact: true });
  const save = editor.getByRole('button', { name: 'Save theme', exact: true });
  const discard = editor.getByRole('button', { name: 'Discard changes', exact: true });
  const advanced = editor.locator('details');
  const accent = editor.locator('[data-custom-theme-color="accent"]');
  await expect(editor).toBeVisible();
  await expect(page.locator('.theme-select, [data-custom-theme-use-preset]')).toHaveCount(0);
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
  await expect(mode).toHaveAccessibleName('Dark appearance');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(mode.locator('use')).toHaveAttribute('href', '/icons/theme-mode.svg#moon');
  await expect(harmony.locator('option')).toHaveText(['Analogous', 'Complementary', 'Triadic', 'Tetradic', 'Square', 'Monochromatic', 'Shades', 'Split complementary']);
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
  await setAppearance(mode, 'light');
  await setRange(hue, 100);
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await discard.click();
  await expect(hue).toHaveValue('220');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
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
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
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
  const terminology = page.locator('.ui-terminology-settings');
  const reference = terminology.locator('.terminology-reference');
  const summary = reference.getByText('Terminology reference', { exact: true });
  await expect(reference).not.toHaveAttribute('open', '');
  expect(await terminology.evaluate(section => {
    const row = section.querySelector('.ui-terminology-copy')?.getBoundingClientRect();
    const reference = section.querySelector('.terminology-reference')?.getBoundingClientRect();
    return row && reference ? reference.top >= row.bottom : false;
  })).toBe(true);
  await terminology.scrollIntoViewIfNeeded();
  await summary.focus();
  await page.mouse.move(0, 0);
  await expect(terminology).toHaveScreenshot(`terminology-reference-collapsed-${width}.png`);
  await summary.press('Enter');
  await expect(reference).toHaveAttribute('open', '');
  await expect(reference.getByRole('table')).toBeVisible();
  await terminology.evaluate(section => section.scrollIntoView({ block: 'start' }));
  const referenceBounds = await terminology.boundingBox();
  if (!referenceBounds) throw new Error('Missing terminology reference bounds');
  await expect(page).toHaveScreenshot(`terminology-reference-expanded-${width}.png`, { clip: { ...referenceBounds, height: Math.min(referenceBounds.height, 340) } });
  await summary.press('Enter');
  await expect(reference).not.toHaveAttribute('open', '');
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
  await expect(editor.locator('[data-custom-theme-mode]')).toHaveAttribute('aria-pressed', 'true');
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
    const result = await inputThemeContrast(page, ['[data-key="CUSTOM_NOTE"] input', '[data-custom-theme-harmony]']);
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
      if (width === 390) await hue.evaluate(input => input.scrollIntoView({ block: 'center' }));
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
  for (const mode of ['dark', 'light'] as const) for (const { value: harmony } of THEME_HARMONIES.filter(({ value }) => value !== 'palette')) for (const extreme of [0, 100]) {
    await setAppearance(editor.locator('[data-custom-theme-mode]'), mode);
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

for (const harmony of ['tetradic', 'square', 'monochromatic', 'shades', 'split-complementary']) test(`new ${harmony} harmony persists and restores before application startup`, async ({ page }) => {
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  const choice = editor.getByLabel('Color harmony', { exact: true });
  await setRange(editor.getByRole('slider', { name: 'Hue', exact: true }), 270);
  await setRange(editor.getByRole('slider', { name: 'Saturation', exact: true }), 80);
  await choice.selectOption(harmony);
  await editor.getByRole('button', { name: 'Save theme', exact: true }).click();
  expect(await storedTheme(page)).toMatchObject({ version: 3, recipe: { settings: { harmony, hue: 270, saturation: 80 } } });
  const saved = await themeVars(page);
  await page.reload();
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  await expect(choice).toHaveValue(harmony);
  expect(await themeVars(page)).toEqual(saved);
  await page.route('**/assets/*.js', route => route.abort());
  await page.reload();
  await expect(page.locator('#boot')).toBeVisible();
  expect(await themeVars(page)).toEqual(saved);
});

for (const mode of ['dark', 'light'] as const) test(`five-color source palette survives generator changes in ${mode} appearance`, async ({ page }) => {
  const colors = ['#152b44', '#dfead2', '#e95f52', '#6ea867', '#827298'];
  const recipe = createThemeRecipeFromPalette(colors);
  if (!recipe) throw new Error('Invalid five-color browser fixture');
  const initial = generateThemePalette(recipe.settings, 'dark', recipe.overrides, recipe.sourcePalette);
  await page.addInitScript(value => {
    if (!localStorage.getItem('cmux.theme.custom')) localStorage.setItem('cmux.theme.custom', value);
  }, JSON.stringify({ version: 3, palette: initial, recipe }));
  await mockConfig(page);
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  const editor = page.locator('[data-custom-theme-editor]');
  const choice = editor.getByLabel('Color harmony', { exact: true });
  await expect(choice).toHaveValue('palette');
  await expect(choice.locator('option[value="palette"]')).toHaveText('Palette colors');
  await setAppearance(editor.locator('[data-custom-theme-mode]'), mode);
  await setRange(editor.getByRole('slider', { name: 'Hue', exact: true }), 240);
  await choice.selectOption('square');
  await editor.getByText('Advanced color overrides', { exact: true }).click();
  await editor.locator('[data-custom-theme-color="accent"]').fill('#44005c');
  await selectWheel(page, editor.locator('[data-custom-theme-wheel]'), 135, 65);
  await expectWheelSelection(editor, 135, 65);
  await editor.getByRole('button', { name: 'Save theme', exact: true }).click();
  expect(await storedTheme(page)).toMatchObject({ version: 3, recipe: { sourcePalette: colors, settings: { harmony: 'square', hue: 135, brightness: 65 }, overrides: { accent: '#44005c' } }, palette: { mode, accent: '#44005c' } });
  const saved = await themeVars(page);
  await editor.getByRole('button', { name: 'Save theme', exact: true }).hover();
  const contrast = await inputThemeContrast(page, ['[data-key="CUSTOM_NOTE"] input']);
  expect(contrast.body).toBeGreaterThanOrEqual(4.5);
  expect(contrast.button).toBeGreaterThanOrEqual(4.5);
  expect(contrast.command).toBeGreaterThanOrEqual(4.5);
  expect(contrast.controls[0]?.value).toBeGreaterThanOrEqual(4.5);
  await page.reload();
  await expect(page.locator('[data-key="CUSTOM_NOTE"] input')).toBeVisible();
  await expect(choice).toHaveValue('square');
  await expect(editor.locator('[data-custom-theme-mode]')).toHaveAttribute('aria-pressed', String(mode === 'dark'));
  expect(await themeVars(page)).toEqual(saved);
  expect(await storedTheme(page)).toMatchObject({ recipe: { sourcePalette: colors } });
  await page.route('**/assets/*.js', route => route.abort());
  await page.reload();
  await expect(page.locator('#boot')).toBeVisible();
  expect(await themeVars(page)).toEqual(saved);
});

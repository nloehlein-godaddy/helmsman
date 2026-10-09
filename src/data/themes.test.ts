import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCustomTheme, CUSTOM_THEME_FIELDS, CUSTOM_THEME_STORAGE_KEY, customThemeFromPalette, DEFAULT_THEME_ID, loadCustomTheme, loadCustomThemeRecipe, REQUIRED_VAR_KEYS, saveCustomTheme, type CustomThemePalette } from './themes';
import { createThemeRecipeFromPalette, DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette, THEME_HARMONIES, type ThemeGeneratorRecipe } from './themeGenerator';

function luminance(hex: string): number {
  const channels = (hex.match(/[a-f\d]{2}/gi) ?? []).map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(first: string, second: string): number {
  return (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);
}

const defaultPalette = () => generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark');
const defaultRecipe = (): ThemeGeneratorRecipe => ({ settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS }, overrides: {} });

describe('generated theme roles', () => {
  it('supplies every required role for the sole custom theme', () => {
    const theme = customThemeFromPalette(defaultPalette());
    expect(theme.id).toBe(DEFAULT_THEME_ID);
    expect(theme.id).toBe('custom');
    for (const key of REQUIRED_VAR_KEYS) expect(theme.vars[key], key).toBeTruthy();
    expect(CUSTOM_THEME_FIELDS.map(field => field.key)).toContain('controlBg');
  });

  it.each(THEME_HARMONIES.filter(({ value }) => value !== 'palette').flatMap(({ value }) => ['dark', 'light'].map(mode => ({ harmony: value, mode: mode as 'dark' | 'light' }))))('keeps all text and semantic roles readable in generated $harmony $mode palettes', ({ harmony, mode }) => {
    for (const hue of [0, 95, 165, 255, 359]) {
      for (const saturation of [0, 100]) {
        for (const brightness of [0, 100]) {
          const palette = generateThemePalette({ hue, saturation, brightness, harmony }, mode);
          const { vars } = customThemeFromPalette(palette);
          for (const role of ['--text', '--text-dim', '--text-faint', '--accent-text', '--accent-text-hover', '--secondary-text', '--bad', '--good', '--review', '--queued']) {
            for (const surface of ['--bg', '--gutter', '--panel', '--panel-2', '--panel-hi']) {
              expect(contrast(vars[role]!, vars[surface]!), `${mode} ${hue}/${saturation}/${brightness} ${role} on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
          }
          expect(contrast(vars['--on-accent']!, vars['--accent']!)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(vars['--on-good']!, vars['--good']!)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(vars['--section-nav-text']!, vars['--section-nav-bg']!)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(vars['--section-nav-text']!, vars['--section-nav-hover']!)).toBeGreaterThanOrEqual(4.5);
          for (const role of ['--input-text', '--input-placeholder', '--input-accent']) expect(contrast(vars[role]!, vars['--control-bg']!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it.each(['dark', 'light'] as const)('keeps independently overridden inputs readable in %s mode', mode => {
    for (const controlBg of ['#ffffff', '#000000', '#777777', '#44005c']) {
      const palette = generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, mode, { controlBg, accent: '#44005c' });
      const theme = customThemeFromPalette(palette);
      for (const role of ['--input-text', '--input-placeholder', '--input-accent']) expect(contrast(theme.vars[role]!, controlBg)).toBeGreaterThanOrEqual(4.5);
      expect(theme.vars['--control-bg']).toBe(controlBg);
      expect(palette.controlBg).toBe(controlBg);
    }
  });

  it.each(['dark', 'light'] as const)('keeps five-color source roles readable across harmonies and %s extremes', mode => {
    for (const colors of [['#152b44', '#dfead2', '#e95f52', '#6ea867', '#827298'], ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff'], ['#000000', '#ffffff', '#333333', '#777777', '#aaaaaa']]) {
      const recipe = createThemeRecipeFromPalette(colors)!;
      for (const { value: harmony } of THEME_HARMONIES) {
        for (const saturation of [0, 100]) {
          for (const brightness of [0, 100]) {
            const palette = generateThemePalette({ ...recipe.settings, harmony, saturation, brightness }, mode, {}, recipe.sourcePalette);
            for (const color of Object.values(palette).filter(color => color !== mode)) expect(color).toMatch(/^#[a-f\d]{6}$/i);
            const { vars } = customThemeFromPalette(palette);
            for (const role of ['--text', '--text-dim', '--text-faint', '--accent-text', '--secondary-text', '--bad', '--good', '--review', '--queued']) {
              for (const surface of ['--bg', '--gutter', '--panel', '--panel-2', '--panel-hi']) expect(contrast(vars[role]!, vars[surface]!), `${harmony} ${role} on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
            for (const role of ['--input-text', '--input-placeholder', '--input-accent']) expect(contrast(vars[role]!, vars['--control-bg']!)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(vars['--section-nav-text']!, vars['--section-nav-bg']!)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(vars['--section-nav-text']!, vars['--section-nav-hover']!)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(vars['--on-accent']!, vars['--accent']!)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  it('corrects near-threshold text with the closest passing derived gray', () => {
    const palette = { ...defaultPalette(), bg: '#ffffff', gutter: '#ffffff', panel: '#ffffff', panel2: '#ffffff', panelHi: '#ffffff', text: '#777777' };
    const derived = customThemeFromPalette(palette).vars['--text']!;
    expect(contrast(derived, palette.panel)).toBeGreaterThanOrEqual(4.5);
    const channel = parseInt(derived.slice(1, 3), 16);
    const lighter = '#' + (channel + 1).toString(16).padStart(2, '0').repeat(3);
    expect(contrast(lighter, palette.panel)).toBeLessThan(4.5);
    expect(palette.text).toBe('#777777');
  });

  it('bounds impossible mixed-surface contrast deterministically without changing saved colors', () => {
    const palette = { ...defaultPalette(), bg: '#000000', panel: '#ffffff', panelHi: '#777777', accent: '#44005c' };
    const first = customThemeFromPalette(palette);
    expect(customThemeFromPalette(palette)).toEqual(first);
    expect(first.vars['--bg']).toBe(palette.bg);
    expect(first.vars['--panel']).toBe(palette.panel);
    expect(first.vars['--accent-text']).toMatch(/^#[a-f\d]{6}$/i);
    expect(Math.min(...[palette.bg, palette.panel, palette.panelHi].map(surface => contrast(first.vars['--accent-text']!, surface)))).toBeLessThan(4.5);
  });

  it('chooses filled ink for the actual fill and preserves raw fills', () => {
    for (const accent of ['#44005c', '#ffff00']) {
      const theme = customThemeFromPalette({ ...defaultPalette(), accent });
      expect(theme.vars['--accent']).toBe(accent);
      expect(contrast(theme.vars['--on-accent']!, accent)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('atomic generated theme storage', () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['palette', 'split-complementary'] as const)('persists five source colors alongside %s recipes and validates all three atomically', harmony => {
    const recipe = createThemeRecipeFromPalette(['#152B44', '#DFEAD2', '#E95F52', '#6EA867', '#827298'])!;
    recipe.settings.harmony = harmony;
    recipe.overrides.controlBg = '#ffffff';
    const palette = generateThemePalette(recipe.settings, 'dark', recipe.overrides, recipe.sourcePalette);
    expect(saveCustomTheme(palette, recipe)).toBe(true);
    expect(loadCustomTheme()).toEqual(palette);
    expect(loadCustomThemeRecipe()).toEqual(recipe);
    expect(JSON.parse(values.get(CUSTOM_THEME_STORAGE_KEY)!).recipe.sourcePalette).toEqual(['#152b44', '#dfead2', '#e95f52', '#6ea867', '#827298']);
    const before = values.get(CUSTOM_THEME_STORAGE_KEY);
    expect(saveCustomTheme({ ...palette, accent: '#ffffff' }, recipe)).toBe(false);
    expect(values.get(CUSTOM_THEME_STORAGE_KEY)).toBe(before);
    const inconsistent = { ...recipe, sourcePalette: ['#000000', ...(recipe.sourcePalette?.slice(1) ?? [])] };
    values.set(CUSTOM_THEME_STORAGE_KEY, JSON.stringify({ version: 3, palette, recipe: inconsistent }));
    expect(loadCustomThemeRecipe()).toBeUndefined();
    expect(loadCustomTheme()).toEqual(defaultPalette());
  });

  it('saves exact palette and recipe together as version 3', () => {
    const recipe: ThemeGeneratorRecipe = { settings: { hue: 275, saturation: 80, brightness: 60, harmony: 'complementary' }, overrides: { controlBg: '#ffffff', accent: '#44005c' } };
    const palette = generateThemePalette(recipe.settings, 'light', recipe.overrides);
    expect(saveCustomTheme(palette, recipe)).toBe(true);
    expect(JSON.parse(values.get(CUSTOM_THEME_STORAGE_KEY)!)).toEqual({ version: 3, palette, recipe });
    expect(loadCustomTheme()).toEqual(palette);
    expect(loadCustomThemeRecipe()).toEqual(recipe);
    recipe.overrides.controlBg = '#000000';
    expect(loadCustomThemeRecipe()?.overrides.controlBg).toBe('#ffffff');
    expect(values.size).toBe(1);
  });

  it.each([1, 2])('discards version %s themes instead of retaining obsolete themes', version => {
    values.set(CUSTOM_THEME_STORAGE_KEY, JSON.stringify({ version, palette: { ...defaultPalette(), accent: '#44005c' } }));
    expect(loadCustomTheme()).toEqual(defaultPalette());
    expect(loadCustomThemeRecipe()).toBeUndefined();
  });

  it.each([
    '{',
    JSON.stringify({ version: 3, palette: defaultPalette() }),
    JSON.stringify({ version: 3, palette: defaultPalette(), recipe: defaultRecipe(), extra: true }),
    JSON.stringify({ version: 3, palette: { ...defaultPalette(), accent: 'red' }, recipe: defaultRecipe() }),
    JSON.stringify({ version: 3, palette: defaultPalette(), recipe: { ...defaultRecipe(), overrides: { bad: '#000000' } } }),
    JSON.stringify({ version: 3, palette: defaultPalette(), recipe: { ...defaultRecipe(), settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 361 } } }),
  ])('rejects malformed stored envelope %s', raw => {
    values.set(CUSTOM_THEME_STORAGE_KEY, raw);
    expect(loadCustomTheme()).toEqual(defaultPalette());
    expect(loadCustomThemeRecipe()).toBeUndefined();
  });

  it('does not replace a saved theme when the new palette or recipe is invalid', () => {
    saveCustomTheme(defaultPalette(), defaultRecipe());
    const saved = values.get(CUSTOM_THEME_STORAGE_KEY);
    expect(saveCustomTheme({ ...defaultPalette(), accent: 'red' }, defaultRecipe())).toBe(false);
    expect(saveCustomTheme(defaultPalette())).toBe(false);
    expect(saveCustomTheme({ ...defaultPalette(), bad: '#000000' }, defaultRecipe())).toBe(false);
    expect(saveCustomTheme(defaultPalette(), { ...defaultRecipe(), overrides: { bad: '#ffffff' } } as ThemeGeneratorRecipe)).toBe(false);
    const { controlBg: _controlBg, ...incomplete } = defaultPalette();
    expect(saveCustomTheme(incomplete as CustomThemePalette, defaultRecipe())).toBe(false);
    expect(values.get(CUSTOM_THEME_STORAGE_KEY)).toBe(saved);
  });

  it('reports denied writes and safely handles denied reads', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('Denied'); }, getItem: () => { throw new Error('Denied'); } });
    expect(saveCustomTheme(defaultPalette(), defaultRecipe())).toBe(false);
    expect(loadCustomTheme()).toEqual(defaultPalette());
    expect(loadCustomThemeRecipe()).toBeUndefined();
  });
});

describe('theme document application', () => {
  afterEach(() => { document.documentElement.removeAttribute('style'); document.documentElement.removeAttribute('data-theme'); document.documentElement.removeAttribute('data-theme-mode'); document.head.innerHTML = ''; });
  it.each(['dark', 'light'] as const)('applies generated %s theme to document and browser chrome', mode => {
    const palette = generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, mode);
    document.head.innerHTML = '<meta name="theme-color">';
    applyCustomTheme(palette);
    expect(document.documentElement.dataset.theme).toBe('custom');
    expect(document.documentElement.dataset.themeMode).toBe(mode);
    expect(document.documentElement.style.colorScheme).toBe(mode);
    for (const [key, value] of Object.entries(customThemeFromPalette(palette).vars)) expect(document.documentElement.style.getPropertyValue(key)).toBe(value);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(palette.bg);
  });
});

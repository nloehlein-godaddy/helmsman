import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { themeBootstrapScript } from '../../build-theme';
import { CUSTOM_THEME_STORAGE_KEY, customThemeFromPalette, DEFAULT_THEME_ID, loadCustomTheme, loadCustomThemeRecipe } from './themes';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette, type ThemeGeneratorRecipe } from './themeGenerator';

describe('initial generated theme bootstrap', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '<meta name="theme-color">';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-mode');
    document.head.innerHTML = '';
  });

  function bootstrap(raw: string | null, oldSelection = 'dracula'): void {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === CUSTOM_THEME_STORAGE_KEY ? raw : oldSelection });
    new Function(themeBootstrapScript())();
  }

  function expectRuntimeMatches(): void {
    const theme = customThemeFromPalette(loadCustomTheme());
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.dataset.themeMode).toBe(theme.mode);
    expect(document.documentElement.style.colorScheme).toBe(theme.mode);
    for (const [key, value] of Object.entries(theme.vars)) expect(document.documentElement.style.getPropertyValue(key), key).toBe(value);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(theme.vars['--bg']);
  }

  it('ignores obsolete selected preset preferences and uses generated default', () => {
    bootstrap(null);
    expect(loadCustomThemeRecipe()).toBeUndefined();
    expectRuntimeMatches();
  });

  it.each(['dark', 'light'] as const)('matches runtime generated %s colors and independently overridden inputs before first paint', mode => {
    const recipe: ThemeGeneratorRecipe = { settings: { hue: 275, saturation: 95, brightness: 100, harmony: 'triadic' }, overrides: { controlBg: mode === 'dark' ? '#ffffff' : '#000000', accent: '#44005c' } };
    const palette = generateThemePalette(recipe.settings, mode, recipe.overrides);
    bootstrap(JSON.stringify({ version: 3, palette, recipe }));
    expect(loadCustomTheme()).toEqual(palette);
    expect(loadCustomThemeRecipe()).toEqual(recipe);
    expectRuntimeMatches();
  });

  it.each([1, 2])('rejects obsolete version %s palettes without retaining their custom colors', version => {
    const palette = { ...generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light'), accent: '#44005c' };
    bootstrap(JSON.stringify({ version, palette }));
    expect(loadCustomTheme()).toEqual(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'));
    expectRuntimeMatches();
  });

  it.each([
    'broken JSON',
    JSON.stringify({ version: 3, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark') }),
    JSON.stringify({ version: 3, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'), recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: { bad: '#000000' } } }),
    JSON.stringify({ version: 3, palette: { ...generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'), bad: '#000000' }, recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} } }),
  ])('matches runtime fallback with corrupt or inconsistent recipe %s', raw => {
    bootstrap(raw);
    expect(loadCustomThemeRecipe()).toBeUndefined();
    expectRuntimeMatches();
  });

  it('tolerates browser storage denial before the application runs', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('Access denied', 'SecurityError'); } });
    expect(() => new Function(themeBootstrapScript())()).not.toThrow();
    expectRuntimeMatches();
  });
});

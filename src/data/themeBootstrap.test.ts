import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { themeBootstrapScript } from '../../build-theme';
import { AMBER_BACKGROUND, applyTheme, createCustomTheme, CUSTOM_THEME_STORAGE_KEY, customThemeFromPalette, DEFAULT_THEME_ID, getTheme } from './themes';

describe('initial theme bootstrap', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '<meta name="theme-color" content="#081721">';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '';
  });

  function bootstrap(stored: string | null): void {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'cmux.theme' ? stored : null });
    new Function(themeBootstrapScript())();
  }

  it.each(['github-light', 'solarized-light', 'nord', 'amber'])('restores %s before the application runs', (id) => {
    bootstrap(id);
    const theme = getTheme(id);
    expect(document.documentElement.dataset.theme).toBe(id);
    expect(document.documentElement.style.colorScheme).toBe(theme?.mode);
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(theme?.vars['--bg'] ?? '');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(theme?.vars['--bg'] ?? AMBER_BACKGROUND);
  });

  it.each([null, 'removed-theme'])('uses the default for unavailable preference %s', (stored) => {
    bootstrap(stored);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('uses the default when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('Access denied', 'SecurityError'); } });
    expect(() => new Function(themeBootstrapScript())()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('keeps browser chrome aligned when changing themes after startup', () => {
    bootstrap('github-light');
    applyTheme('nord');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(getTheme('nord')?.vars['--bg']);
    applyTheme('amber');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(AMBER_BACKGROUND);
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
  });

  it.each(['nord', 'github-light'])('matches runtime custom colors and mode before first paint from %s', preset => {
    const palette = { ...createCustomTheme(preset), accent: '#123456' };
    const values: Record<string, string> = {
      'cmux.theme': 'custom',
      [CUSTOM_THEME_STORAGE_KEY]: JSON.stringify({ version: 1, palette }),
    };
    vi.stubGlobal('localStorage', { getItem: (key: string) => values[key] ?? null });
    new Function(themeBootstrapScript())();
    const root = document.documentElement;
    const initialStyles = root.getAttribute('style');
    expect(root.dataset.theme).toBe('custom');
    expect(root.style.colorScheme).toBe(palette.mode);
    expect(root.style.getPropertyValue('--accent')).toBe(palette.accent);
    applyTheme('custom');
    expect(root.getAttribute('style')).toBe(initialStyles);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(palette.bg);
  });

  it.each([
    { preset: 'field-guide', accent: '#44005c', ink: '#ffffff' },
    { preset: 'github-light', accent: '#ffff00', ink: '#000000' },
  ])('restores contrast-adjusted custom text before first paint for $preset', ({ preset, accent, ink }) => {
    const palette = { ...createCustomTheme(preset), accent, text: '#777777' };
    const values: Record<string, string> = {
      'cmux.theme': 'custom',
      [CUSTOM_THEME_STORAGE_KEY]: JSON.stringify({ version: 1, palette }),
    };
    vi.stubGlobal('localStorage', { getItem: (key: string) => values[key] ?? null });
    new Function(themeBootstrapScript())();
    const root = document.documentElement;
    const runtime = customThemeFromPalette(palette);
    for (const role of ['--on-accent', '--accent-text', '--accent-text-hover', '--secondary-text', '--text', '--text-dim', '--text-faint', '--nav-text', '--nav-muted']) {
      expect(root.style.getPropertyValue(role)).toBe(runtime.vars[role]);
    }
    expect(root.style.getPropertyValue('--on-accent')).toBe(ink);
    expect(root.style.getPropertyValue('--accent')).toBe(accent);
    const initialStyles = root.getAttribute('style');
    applyTheme('custom');
    expect(root.getAttribute('style')).toBe(initialStyles);
    expect(JSON.parse(values[CUSTOM_THEME_STORAGE_KEY]!).palette).toEqual(palette);
  });

  it.each(['broken JSON', '{"version":1,"palette":{"mode":"dark"}}', JSON.stringify({ version: 1, palette: { ...createCustomTheme('nord'), accent: 'red' } })])('matches the runtime fallback for corrupt custom storage %s', raw => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'cmux.theme' ? 'custom' : raw });
    expect(() => new Function(themeBootstrapScript())()).not.toThrow();
    const initialStyles = document.documentElement.getAttribute('style');
    expect(document.documentElement.dataset.theme).toBe('custom');
    applyTheme('custom');
    expect(document.documentElement.getAttribute('style')).toBe(initialStyles);
  });
});

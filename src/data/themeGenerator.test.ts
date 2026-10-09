import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette, parseThemeGeneratorRecipe, THEME_OVERRIDE_KEYS, type ThemeGeneratorRecipe } from './themeGenerator';

function oklch(hex: string): { lightness: number; chroma: number; hue: number } {
  const [r = 0, g = 0, b = 0] = (hex.slice(1).match(/.{2}/g) ?? []).map(channel => {
    const encoded = parseInt(channel, 16) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const opponentB = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { lightness: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, chroma: Math.hypot(a, opponentB), hue: (Math.atan2(opponentB, a) * 180 / Math.PI + 360) % 360 };
}

const angularDistance = (first: number, second: number): number => Math.abs(((first - second + 540) % 360) - 180);

describe('OKLCH palette generation', () => {
  it('defaults to a restrained analogous palette and wraps the hue endpoint', () => {
    expect(DEFAULT_THEME_GENERATOR_SETTINGS.harmony).toBe('analogous');
    expect(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 0 }, 'dark')).toEqual(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 360 }, 'dark'));
  });

  it.each(['dark', 'light'] as const)('maps out-of-gamut %s colors by reducing chroma while preserving hue and lightness', mode => {
    for (const hue of [0, 30, 90, 150, 210, 270, 330]) {
      for (const brightness of [0, 100]) {
        const settings = { hue, brightness, saturation: 100, harmony: 'analogous' as const };
        const palette = generateThemePalette(settings, mode);
        for (const color of Object.values(palette).filter(value => value !== mode)) expect(color).toMatch(/^#[a-f\d]{6}$/i);
        const accent = oklch(palette.accent);
        expect(angularDistance(accent.hue, hue), `${mode} hue ${hue}`).toBeLessThan(1.5);
        expect(accent.lightness).toBeCloseTo(mode === 'dark' ? 0.67 + brightness / 100 * 0.10 : 0.43 + brightness / 100 * 0.08, 2);
        expect(accent.chroma).toBeLessThanOrEqual(0.202);
      }
    }
  });

  it.each([
    { harmony: 'analogous' as const, secondaryOffset: 35, surfaceOffset: 0 },
    { harmony: 'complementary' as const, secondaryOffset: 180, surfaceOffset: 0 },
    { harmony: 'triadic' as const, secondaryOffset: 120, surfaceOffset: 240 },
  ])('uses the $harmony hue relationship', ({ harmony, secondaryOffset, surfaceOffset }) => {
    const palette = generateThemePalette({ hue: 20, saturation: 100, brightness: 50, harmony }, 'dark');
    expect(angularDistance(oklch(palette.accent).hue, 20)).toBeLessThan(1.5);
    expect(angularDistance(oklch(palette.secondary).hue, 20 + secondaryOffset)).toBeLessThan(1.5);
    expect(angularDistance(oklch(palette.panelHi).hue, 20 + surfaceOffset)).toBeLessThan(3);
  });

  it.each(['dark', 'light'] as const)('retains red/green/blue/yellow status families across %s theme extremes', mode => {
    for (const hue of [0, 165, 280]) {
      for (const saturation of [0, 100]) {
        for (const brightness of [0, 100]) {
          const palette = generateThemePalette({ hue, saturation, brightness, harmony: 'triadic' }, mode);
          for (const [key, targetHue] of [['bad', 25], ['good', 145], ['review', 255], ['queued', 95]] as const) {
            const color = oklch(palette[key]);
            expect(angularDistance(color.hue, targetHue), `${key} at ${hue}/${saturation}/${brightness}`).toBeLessThan(2);
            expect(color.chroma).toBeGreaterThan(0.07);
          }
        }
      }
    }
  });

  it('makes non-semantic colors neutral at zero saturation', () => {
    const palette = generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, saturation: 0 }, 'dark');
    for (const key of THEME_OVERRIDE_KEYS) expect(oklch(palette[key]).chroma).toBeLessThan(0.002);
    expect(oklch(palette.bad).chroma).toBeGreaterThan(0.07);
  });

  it('preserves only explicit advanced overrides when regenerating and clears them by omission', () => {
    const overrides = { controlBg: '#ffffff', accent: '#44005c' };
    const settings = { ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 280, saturation: 90 };
    const palette = generateThemePalette(settings, 'light', overrides);
    expect(palette.controlBg).toBe(overrides.controlBg);
    expect(palette.accent).toBe(overrides.accent);
    expect(generateThemePalette(settings, 'light').accent).not.toBe(overrides.accent);
    expect(generateThemePalette(settings, 'light').controlBg).not.toBe(overrides.controlBg);
    expect(overrides).toEqual({ controlBg: '#ffffff', accent: '#44005c' });
  });

  it('safely falls back for malformed runtime settings or forbidden semantic overrides', () => {
    expect(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: Number.NaN }, 'dark')).toEqual(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'));
    expect(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark', { bad: '#000000' } as ThemeGeneratorRecipe['overrides'])).toEqual(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'));
  });
});

describe('recipe validation', () => {
  it('clones valid fractional settings and accepted individual hex overrides', () => {
    const recipe = { settings: { hue: 359.5, saturation: 35.5, brightness: 45.5, harmony: 'complementary' }, overrides: { controlBg: '#ABCDEF' } };
    const parsed = parseThemeGeneratorRecipe(recipe);
    expect(parsed).toEqual(recipe);
    expect(parsed?.settings).not.toBe(recipe.settings);
    expect(parsed?.overrides).not.toBe(recipe.overrides);
  });

  it.each([
    null, [], {},
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {}, extra: true },
    { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: -1 }, overrides: {} },
    { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, brightness: Number.POSITIVE_INFINITY }, overrides: {} },
    { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, saturation: '50' }, overrides: {} },
    { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, harmony: 'rainbow' }, overrides: {} },
    { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, surprise: true }, overrides: {} },
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: [] },
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: { accent: 'red' } },
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: { accent: '#abc' } },
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: { bad: '#ffffff' } },
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: { mode: 'light' } },
    { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: { unknown: '#000000' } },
  ])('rejects malformed recipe %j', recipe => {
    expect(parseThemeGeneratorRecipe(recipe)).toBeUndefined();
  });
});

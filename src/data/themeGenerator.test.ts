import { describe, expect, it } from 'vitest';
import { createThemeRecipeFromPalette, DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette, parseFiveColorPalette, parseThemeGeneratorRecipe, THEME_HARMONIES, THEME_OVERRIDE_KEYS, type FiveColorPalette, type ThemeGeneratorRecipe } from './themeGenerator';

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
const sourceColors: FiveColorPalette = ['#152b44', '#dfead2', '#e95f52', '#6ea867', '#827298'];

describe('five-color palettes', () => {
  it('creates a cloned recipe seeded by the most colorful middle color', () => {
    const input = sourceColors.map(color => color.toUpperCase());
    const recipe = createThemeRecipeFromPalette(input)!;
    expect(recipe.sourcePalette).toEqual(sourceColors);
    expect(recipe.settings.harmony).toBe('palette');
    expect(recipe.settings.saturation).toBe(35);
    expect(recipe.settings.brightness).toBe(45);
    expect(Number.isInteger(recipe.settings.hue)).toBe(true);
    expect(angularDistance(recipe.settings.hue, oklch(sourceColors[2]).hue)).toBeLessThanOrEqual(0.5);
    input[0] = '#ffffff';
    expect(recipe.sourcePalette?.[0]).toBe(sourceColors[0]);
    expect(parseThemeGeneratorRecipe(recipe)).toEqual(recipe);
    expect(parseThemeGeneratorRecipe(recipe)?.sourcePalette).not.toBe(recipe.sourcePalette);
  });

  it.each(['dark', 'light'] as const)('uses all five seeds for appropriate %s roles without depending on input order', mode => {
    const recipe = createThemeRecipeFromPalette(sourceColors)!;
    const palette = generateThemePalette(recipe.settings, mode, {}, recipe.sourcePalette);
    const expectedSeeds = { bg: mode === 'dark' ? sourceColors[0] : sourceColors[1], text: mode === 'dark' ? sourceColors[1] : sourceColors[0], accent: sourceColors[2], secondary: sourceColors[3], panelHi: sourceColors[4] };
    for (const [role, seed] of Object.entries(expectedSeeds)) {
      expect(angularDistance(oklch(palette[role as keyof typeof expectedSeeds]).hue, oklch(seed).hue), role).toBeLessThan(8);
    }
    const reversed = createThemeRecipeFromPalette([...sourceColors].reverse())!;
    expect(generateThemePalette(reversed.settings, mode, {}, reversed.sourcePalette)).toEqual(palette);
    for (let index = 0; index < 5; index++) {
      const modified = [...sourceColors];
      const color = modified[index]!;
      modified[index] = color.slice(0, 3) + (parseInt(color.slice(3, 5), 16) - 8).toString(16).padStart(2, '0') + color.slice(5);
      const changed = createThemeRecipeFromPalette(modified)!;
      expect(generateThemePalette(changed.settings, mode, {}, changed.sourcePalette), `source ${index}`).not.toEqual(palette);
    }
  });

  it('rotates every seed hue together and zero saturation neutralizes every nonsemantic role', () => {
    const recipe = createThemeRecipeFromPalette(sourceColors)!;
    const initial = generateThemePalette(recipe.settings, 'dark', {}, recipe.sourcePalette);
    const rotated = generateThemePalette({ ...recipe.settings, hue: (recipe.settings.hue + 60) % 360 }, 'dark', {}, recipe.sourcePalette);
    for (const role of ['accent', 'secondary', 'panelHi', 'bg', 'text'] as const) expect(angularDistance(oklch(rotated[role]).hue, oklch(initial[role]).hue + 60), role).toBeLessThan(8);
    const neutral = generateThemePalette({ ...recipe.settings, saturation: 0 }, 'dark', {}, recipe.sourcePalette);
    for (const role of THEME_OVERRIDE_KEYS) expect(oklch(neutral[role]).chroma, role).toBeLessThan(0.002);
    expect(neutral.bad).toBe(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, saturation: 0 }, 'dark').bad);
  });

  it('can deliberately replace source hue relationships with a harmony while retaining its five seeds', () => {
    const recipe = createThemeRecipeFromPalette(sourceColors)!;
    const palette = generateThemePalette({ ...recipe.settings, harmony: 'square' }, 'dark', { controlBg: '#ffffff' }, recipe.sourcePalette);
    expect(angularDistance(oklch(palette.accent).hue, recipe.settings.hue)).toBeLessThan(2);
    expect(angularDistance(oklch(palette.secondary).hue, recipe.settings.hue + 180)).toBeLessThan(2);
    expect(angularDistance(oklch(palette.panelHi).hue, recipe.settings.hue + 90)).toBeLessThan(4);
    expect(palette.controlBg).toBe('#ffffff');
  });

  it.each([null, undefined, {}, [], Array(5), ['#ffffff'], [...sourceColors, '#ffffff'], ['#fff', ...sourceColors.slice(1)], ['red', ...sourceColors.slice(1)], [123, ...sourceColors.slice(1)]])('rejects malformed five-color input %j', value => {
    expect(parseFiveColorPalette(value)).toBeUndefined();
    expect(createThemeRecipeFromPalette(value)).toBeUndefined();
    expect(parseThemeGeneratorRecipe({ settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, harmony: 'palette' }, overrides: {}, sourcePalette: value })).toBeUndefined();
  });

  it('requires five source colors for the palette harmony and falls back safely at runtime', () => {
    const settings = { ...DEFAULT_THEME_GENERATOR_SETTINGS, harmony: 'palette' as const };
    expect(parseThemeGeneratorRecipe({ settings, overrides: {} })).toBeUndefined();
    expect(generateThemePalette(settings, 'dark')).toEqual(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'));
  });
});

describe('OKLCH palette generation', () => {
  it('defaults to a restrained analogous palette and wraps the hue endpoint', () => {
    expect(DEFAULT_THEME_GENERATOR_SETTINGS.harmony).toBe('analogous');
    expect(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 0 }, 'dark')).toEqual(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 360 }, 'dark'));
  });

  it.each([
    { harmony: 'analogous' as const, bg: '#150404', gutter: '#110203', panel: '#200c0c', panel2: '#281313', panelHi: '#2f1919', controlBg: '#190606', secondary: '#ef852e' },
    { harmony: 'complementary' as const, bg: '#150404', gutter: '#110203', panel: '#200c0c', panel2: '#281313', panelHi: '#2f1919', controlBg: '#190606', secondary: '#00bbc3' },
    { harmony: 'triadic' as const, bg: '#030917', gutter: '#010614', panel: '#091322', panel2: '#101a2a', panelHi: '#162131', controlBg: '#040c1b', secondary: '#69bc57' },
  ])('preserves previously saved $harmony recipe colors exactly', ({ harmony, ...colors }) => {
    expect(generateThemePalette({ hue: 20, saturation: 100, brightness: 50, harmony }, 'dark')).toEqual({
      mode: 'dark', ...colors, accent: '#ff7076', text: '#fceae9', textDim: '#cab9b8', textFaint: '#a49493',
      bad: '#ff7e77', good: '#61c568', review: '#6dadff', queued: '#c9a800',
    });
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

  it.each([
    { harmony: 'tetradic' as const, secondaryOffset: 180, surfaceOffset: 60, gutterOffset: 240 },
    { harmony: 'square' as const, secondaryOffset: 180, surfaceOffset: 90, gutterOffset: 270 },
    { harmony: 'split-complementary' as const, secondaryOffset: 150, surfaceOffset: 210, gutterOffset: 210 },
  ])('distributes the $harmony hues across accents, surfaces, and navigation', ({ harmony, secondaryOffset, surfaceOffset, gutterOffset }) => {
    const palette = generateThemePalette({ hue: 350, saturation: 100, brightness: 100, harmony }, 'dark');
    expect(angularDistance(oklch(palette.accent).hue, 350)).toBeLessThan(1.5);
    expect(angularDistance(oklch(palette.secondary).hue, (350 + secondaryOffset) % 360)).toBeLessThan(1.5);
    for (const key of ['bg', 'panel', 'panel2', 'panelHi', 'controlBg'] as const) {
      expect(angularDistance(oklch(palette[key]).hue, (350 + surfaceOffset) % 360), key).toBeLessThan(4);
      expect(oklch(palette[key]).chroma).toBeLessThan(0.037);
    }
    expect(angularDistance(oklch(palette.gutter).hue, (350 + gutterOffset) % 360)).toBeLessThan(4);
  });

  it.each(['dark', 'light'] as const)('distinguishes monochromatic lightness/chroma variation from darker shades in %s mode', mode => {
    const settings = { hue: 170, saturation: 30, brightness: 50 };
    const monochromatic = generateThemePalette({ ...settings, harmony: 'monochromatic' }, mode);
    const shades = generateThemePalette({ ...settings, harmony: 'shades' }, mode);
    const accent = oklch(monochromatic.accent);
    const monoSecondary = oklch(monochromatic.secondary);
    const shadeSecondary = oklch(shades.secondary);
    expect(shades.accent).toBe(monochromatic.accent);
    expect(monoSecondary.lightness - accent.lightness).toBeCloseTo(mode === 'dark' ? 0.08 : -0.08, 2);
    expect(shadeSecondary.lightness - accent.lightness).toBeCloseTo(-0.12, 2);
    expect(monoSecondary.chroma / accent.chroma).toBeCloseTo(0.45, 1);
    expect(shadeSecondary.chroma / accent.chroma).toBeCloseTo(1, 1);
    for (const palette of [monochromatic, shades]) {
      for (const key of ['accent', 'secondary', 'panelHi'] as const) expect(angularDistance(oklch(palette[key]).hue, settings.hue), key).toBeLessThan(4);
    }
  });

  it.each(THEME_HARMONIES.filter(({ value }) => value !== 'palette').flatMap(({ value }) => ['dark', 'light'].map(mode => ({ harmony: value, mode: mode as 'dark' | 'light' }))))('retains red/green/blue/yellow status families across $harmony $mode extremes', ({ harmony, mode }) => {
    for (const hue of [0, 165, 280]) {
      for (const saturation of [0, 100]) {
        for (const brightness of [0, 100]) {
          const palette = generateThemePalette({ hue, saturation, brightness, harmony }, mode);
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
  it.each(THEME_HARMONIES.filter(({ value }) => value !== 'palette'))('accepts the shared $label recipe choice', ({ value }) => {
    const recipe = { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, harmony: value }, overrides: {} };
    expect(parseThemeGeneratorRecipe(recipe)).toEqual(recipe);
  });
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

import type { CustomThemePalette, ThemeMode } from './themes';

export const THEME_HARMONIES = [
  { value: 'analogous', label: 'Analogous' },
  { value: 'complementary', label: 'Complementary' },
  { value: 'triadic', label: 'Triadic' },
  { value: 'tetradic', label: 'Tetradic' },
  { value: 'square', label: 'Square' },
  { value: 'monochromatic', label: 'Monochromatic' },
  { value: 'shades', label: 'Shades' },
  { value: 'split-complementary', label: 'Split complementary' },
  { value: 'palette', label: 'Palette colors' },
] as const;

export type ThemeHarmony = typeof THEME_HARMONIES[number]['value'];

const HARMONY_HUE_OFFSETS: Record<ThemeHarmony, { secondary: number; surface: number; gutter: number }> = {
  analogous: { secondary: 35, surface: 0, gutter: 0 },
  complementary: { secondary: 180, surface: 0, gutter: 0 },
  triadic: { secondary: 120, surface: 240, gutter: 240 },
  tetradic: { secondary: 180, surface: 60, gutter: 240 },
  square: { secondary: 180, surface: 90, gutter: 270 },
  monochromatic: { secondary: 0, surface: 0, gutter: 0 },
  shades: { secondary: 0, surface: 0, gutter: 0 },
  'split-complementary': { secondary: 150, surface: 210, gutter: 210 },
  palette: { secondary: 0, surface: 0, gutter: 0 },
};

export interface ThemeGeneratorSettings {
  hue: number;
  saturation: number;
  brightness: number;
  harmony: ThemeHarmony;
}

export type ThemeOverrideKey = Exclude<keyof CustomThemePalette, 'mode' | 'bad' | 'good' | 'review' | 'queued'>;
export type FiveColorPalette = readonly [string, string, string, string, string];

export interface ThemeGeneratorRecipe {
  settings: ThemeGeneratorSettings;
  overrides: Partial<Pick<CustomThemePalette, ThemeOverrideKey>>;
  sourcePalette?: FiveColorPalette;
}

export const DEFAULT_THEME_GENERATOR_SETTINGS: Readonly<ThemeGeneratorSettings> = {
  hue: 165, saturation: 35, brightness: 45, harmony: 'analogous',
};

export const THEME_OVERRIDE_KEYS: readonly ThemeOverrideKey[] = [
  'bg', 'gutter', 'panel', 'panel2', 'panelHi', 'controlBg', 'accent', 'secondary', 'text', 'textDim', 'textFaint',
];

export function parseFiveColorPalette(value: unknown): FiveColorPalette | undefined {
  if (!Array.isArray(value) || value.length !== 5 || Array.from(value).some(color => typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color))) return undefined;
  return [...value] as unknown as FiveColorPalette;
}

export function parseThemeGeneratorRecipe(value: unknown): ThemeGeneratorRecipe | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const recipe = value as Record<string, unknown>;
  const hasSource = Object.hasOwn(recipe, 'sourcePalette');
  if (Object.keys(recipe).length !== (hasSource ? 3 : 2) || !Object.hasOwn(recipe, 'settings') || !Object.hasOwn(recipe, 'overrides')) return undefined;
  if (!recipe.settings || typeof recipe.settings !== 'object' || Array.isArray(recipe.settings)) return undefined;
  const settings = recipe.settings as Record<string, unknown>;
  if (Object.keys(settings).length !== 4 || !['hue', 'saturation', 'brightness', 'harmony'].every(key => Object.hasOwn(settings, key))) return undefined;
  for (const key of ['hue', 'saturation', 'brightness']) {
    const number = settings[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > (key === 'hue' ? 360 : 100)) return undefined;
  }
  const harmony = THEME_HARMONIES.find(option => option.value === settings.harmony)?.value;
  if (!harmony) return undefined;
  const sourcePalette = hasSource ? parseFiveColorPalette(recipe.sourcePalette) : undefined;
  if ((hasSource && !sourcePalette) || (harmony === 'palette' && !sourcePalette)) return undefined;
  if (!recipe.overrides || typeof recipe.overrides !== 'object' || Array.isArray(recipe.overrides)) return undefined;
  const overrides = recipe.overrides as Record<string, unknown>;
  for (const [key, color] of Object.entries(overrides)) {
    if (!(THEME_OVERRIDE_KEYS as readonly string[]).includes(key) || typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color)) return undefined;
  }
  return { settings: { hue: settings.hue as number, saturation: settings.saturation as number, brightness: settings.brightness as number, harmony }, overrides: { ...overrides } as ThemeGeneratorRecipe['overrides'], ...(sourcePalette ? { sourcePalette } : {}) };
}

function hexOklch(hex: string): { lightness: number; chroma: number; hue: number } {
  const [r = 0, g = 0, b = 0] = (hex.slice(1).match(/.{2}/g) ?? []).map(channel => {
    const encoded = parseInt(channel, 16) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const opponentB = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const chroma = Math.hypot(a, opponentB);
  return { lightness: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, chroma, hue: chroma < 0.002 ? 0 : (Math.atan2(opponentB, a) * 180 / Math.PI + 360) % 360 };
}

function fiveColorSeeds(colors: FiveColorPalette) {
  const sorted = colors.map(hexOklch).sort((first, second) => first.lightness - second.lightness);
  const middle = sorted.slice(1, 4).sort((first, second) => second.chroma - first.chroma);
  return { darkest: sorted[0]!, lightest: sorted[4]!, primary: middle[0]!, companion: middle[1]!, panel: middle[2]! };
}

export function createThemeRecipeFromPalette(value: unknown): ThemeGeneratorRecipe | undefined {
  const colors = parseFiveColorPalette(value);
  if (!colors) return undefined;
  const sourcePalette = colors.map(color => color.toLowerCase()) as unknown as FiveColorPalette;
  return { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: Math.round(fiveColorSeeds(sourcePalette).primary.hue) % 360, harmony: 'palette' }, overrides: {}, sourcePalette };
}

function linearRgb(lightness: number, chroma: number, hue: number): number[] {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

export function oklchHex(lightness: number, chroma: number, hue: number): string {
  let rgb = linearRgb(lightness, chroma, hue);
  const inGamut = (channels: number[]): boolean => channels.every(channel => channel >= 0 && channel <= 1);
  if (!inGamut(rgb)) {
    let lower = 0;
    let upper = chroma;
    for (let step = 0; step < 24; step++) {
      const middle = (lower + upper) / 2;
      if (inGamut(linearRgb(lightness, middle, hue))) lower = middle;
      else upper = middle;
    }
    rgb = linearRgb(lightness, lower, hue);
  }
  return '#' + rgb.map(channel => {
    const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('');
}

function generateFiveColorRoles(recipe: ThemeGeneratorRecipe & { sourcePalette: FiveColorPalette }, mode: ThemeMode): Pick<CustomThemePalette, ThemeOverrideKey> {
  const { settings, sourcePalette } = recipe;
  const seeds = fiveColorSeeds(sourcePalette);
  const isDark = mode === 'dark';
  const background = isDark ? seeds.darkest : seeds.lightest;
  const foreground = isDark ? seeds.lightest : seeds.darkest;
  const brightness = settings.brightness / 100;
  const saturationScale = settings.saturation / DEFAULT_THEME_GENERATOR_SETTINGS.saturation;
  const rotation = settings.hue - Math.round(seeds.primary.hue) % 360;
  const hueOffsets = HARMONY_HUE_OFFSETS[settings.harmony];
  const roleHue = (seed: { hue: number }, offset: number): number => (settings.harmony === 'palette' ? seed.hue + rotation + 360 : settings.hue + offset) % 360;
  const chroma = (seed: { chroma: number }, ceiling: number): number => Math.min(seed.chroma * saturationScale, ceiling);
  const surfaceBase = (isDark ? 0.10 + brightness * 0.08 : 0.92 + brightness * 0.06) + (background.lightness - 0.5) * 0.02;
  const surface = (offset: number, seed = seeds.panel, hueOffset = hueOffsets.surface): string => oklchHex(
    Math.min(0.995, Math.max(0.015, surfaceBase + (isDark ? offset : -offset))), chroma(seed, 0.035), roleHue(seed, hueOffset),
  );
  const accentBase = isDark ? 0.67 + brightness * 0.10 : 0.43 + brightness * 0.08;
  const accentLightness = accentBase + (seeds.primary.lightness - 0.5) * 0.05;
  const secondaryBase = accentBase + (seeds.companion.lightness - 0.5) * 0.05;
  const secondaryLightness = settings.harmony === 'monochromatic' ? accentLightness + (isDark ? 0.08 : -0.08) : settings.harmony === 'shades' ? accentLightness - 0.12 : secondaryBase;
  const secondaryChroma = settings.harmony === 'monochromatic' ? chroma(seeds.primary, 0.20) * 0.45 : settings.harmony === 'shades' ? chroma(seeds.primary, 0.20) : chroma(seeds.companion, 0.20);
  const text = (lightness: number): string => oklchHex(lightness + (foreground.lightness - 0.5) * 0.02, chroma(foreground, 0.02), roleHue(foreground, 0));
  return {
    bg: surface(0, background), gutter: surface(-0.015, background, hueOffsets.gutter),
    panel: surface(0.045), panel2: surface(0.075), panelHi: surface(0.105), controlBg: surface(0.015),
    accent: oklchHex(accentLightness, chroma(seeds.primary, 0.20), roleHue(seeds.primary, 0)),
    secondary: oklchHex(secondaryLightness, secondaryChroma, roleHue(seeds.companion, hueOffsets.secondary)),
    text: text(isDark ? 0.95 : 0.20), textDim: text(isDark ? 0.80 : 0.32), textFaint: text(isDark ? 0.68 : 0.42),
  };
}

export function generateThemePalette(settings: ThemeGeneratorSettings, mode: ThemeMode, overrides: ThemeGeneratorRecipe['overrides'] = {}, sourcePalette?: FiveColorPalette): CustomThemePalette {
  const recipe = parseThemeGeneratorRecipe({ settings, overrides, ...(sourcePalette !== undefined ? { sourcePalette } : {}) });
  const valid = recipe?.settings ?? DEFAULT_THEME_GENERATOR_SETTINGS;
  const safeMode = mode === 'light' ? 'light' : 'dark';
  const hue = valid.hue % 360;
  const saturation = valid.saturation / 100;
  const brightness = valid.brightness / 100;
  const surfaceChroma = saturation * 0.035;
  const hueOffsets = HARMONY_HUE_OFFSETS[valid.harmony];
  const surfaceHue = (hue + hueOffsets.surface) % 360;
  const gutterHue = (hue + hueOffsets.gutter) % 360;
  const surfaceBase = safeMode === 'dark' ? 0.10 + brightness * 0.08 : 0.92 + brightness * 0.06;
  const surface = (offset: number, colorHue = surfaceHue): string => oklchHex(surfaceBase + (safeMode === 'dark' ? offset : -offset), surfaceChroma, colorHue);
  const text = (lightness: number): string => oklchHex(lightness, saturation * 0.02, hue);
  const accentLightness = safeMode === 'dark' ? 0.67 + brightness * 0.10 : 0.43 + brightness * 0.08;
  const accentChroma = saturation * 0.20;
  const secondaryHue = (hue + hueOffsets.secondary) % 360;
  const secondaryLightness = valid.harmony === 'monochromatic' ? accentLightness + (safeMode === 'dark' ? 0.08 : -0.08) : valid.harmony === 'shades' ? accentLightness - 0.12 : accentLightness;
  const secondaryChroma = accentChroma * (valid.harmony === 'monochromatic' ? 0.45 : valid.harmony === 'shades' ? 1 : 0.8);
  const status = (statusHue: number): string => oklchHex(safeMode === 'dark' ? 0.72 + brightness * 0.04 : 0.40 + brightness * 0.02, 0.10 + saturation * 0.06, statusHue);
  const palette: CustomThemePalette = {
    mode: safeMode,
    bg: surface(0), gutter: surface(-0.015, gutterHue), panel: surface(0.045), panel2: surface(0.075), panelHi: surface(0.105), controlBg: surface(0.015),
    accent: oklchHex(accentLightness, accentChroma, hue),
    secondary: oklchHex(secondaryLightness, secondaryChroma, secondaryHue),
    text: text(safeMode === 'dark' ? 0.95 : 0.20),
    textDim: text(safeMode === 'dark' ? 0.80 : 0.32),
    textFaint: text(safeMode === 'dark' ? 0.68 : 0.42),
    bad: status(25), good: status(145), review: status(255), queued: status(95),
  };
  const sourceRoles = recipe?.sourcePalette ? generateFiveColorRoles({ ...recipe, sourcePalette: recipe.sourcePalette }, safeMode) : {};
  return { ...palette, ...sourceRoles, ...(recipe?.overrides ?? {}) };
}

export function themeGeneratorBootstrapSource(): string {
  const serialize = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
  return `const DEFAULT_THEME_GENERATOR_SETTINGS = ${serialize(DEFAULT_THEME_GENERATOR_SETTINGS)};
    const THEME_HARMONIES = ${serialize(THEME_HARMONIES)};
    const HARMONY_HUE_OFFSETS = ${serialize(HARMONY_HUE_OFFSETS)};
    const THEME_OVERRIDE_KEYS = ${serialize(THEME_OVERRIDE_KEYS)};
    ${parseFiveColorPalette.toString()}
    ${parseThemeGeneratorRecipe.toString()}
    ${hexOklch.toString()}
    ${fiveColorSeeds.toString()}
    ${linearRgb.toString()}
    ${oklchHex.toString()}
    ${generateFiveColorRoles.toString()}
    ${generateThemePalette.toString()}`;
}

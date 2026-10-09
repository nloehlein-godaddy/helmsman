import type { CustomThemePalette, ThemeMode } from './themes';

export interface ThemeGeneratorSettings {
  hue: number;
  saturation: number;
  brightness: number;
  harmony: 'analogous' | 'complementary' | 'triadic';
}

export type ThemeOverrideKey = Exclude<keyof CustomThemePalette, 'mode' | 'bad' | 'good' | 'review' | 'queued'>;

export interface ThemeGeneratorRecipe {
  settings: ThemeGeneratorSettings;
  overrides: Partial<Pick<CustomThemePalette, ThemeOverrideKey>>;
}

export const DEFAULT_THEME_GENERATOR_SETTINGS: Readonly<ThemeGeneratorSettings> = {
  hue: 165, saturation: 35, brightness: 45, harmony: 'analogous',
};

export const THEME_OVERRIDE_KEYS: readonly ThemeOverrideKey[] = [
  'bg', 'gutter', 'panel', 'panel2', 'panelHi', 'controlBg', 'accent', 'secondary', 'text', 'textDim', 'textFaint',
];

export function parseThemeGeneratorRecipe(value: unknown): ThemeGeneratorRecipe | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const recipe = value as Record<string, unknown>;
  if (Object.keys(recipe).length !== 2 || !Object.hasOwn(recipe, 'settings') || !Object.hasOwn(recipe, 'overrides')) return undefined;
  if (!recipe.settings || typeof recipe.settings !== 'object' || Array.isArray(recipe.settings)) return undefined;
  const settings = recipe.settings as Record<string, unknown>;
  if (Object.keys(settings).length !== 4 || !['hue', 'saturation', 'brightness', 'harmony'].every(key => Object.hasOwn(settings, key))) return undefined;
  for (const key of ['hue', 'saturation', 'brightness']) {
    const number = settings[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > (key === 'hue' ? 360 : 100)) return undefined;
  }
  if (settings.harmony !== 'analogous' && settings.harmony !== 'complementary' && settings.harmony !== 'triadic') return undefined;
  if (!recipe.overrides || typeof recipe.overrides !== 'object' || Array.isArray(recipe.overrides)) return undefined;
  const overrides = recipe.overrides as Record<string, unknown>;
  for (const [key, color] of Object.entries(overrides)) {
    if (!(THEME_OVERRIDE_KEYS as readonly string[]).includes(key) || typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color)) return undefined;
  }
  return { settings: { hue: settings.hue as number, saturation: settings.saturation as number, brightness: settings.brightness as number, harmony: settings.harmony }, overrides: { ...overrides } as ThemeGeneratorRecipe['overrides'] };
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

function oklchHex(lightness: number, chroma: number, hue: number): string {
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

export function generateThemePalette(settings: ThemeGeneratorSettings, mode: ThemeMode, overrides: ThemeGeneratorRecipe['overrides'] = {}): CustomThemePalette {
  const recipe = parseThemeGeneratorRecipe({ settings, overrides });
  const valid = recipe?.settings ?? DEFAULT_THEME_GENERATOR_SETTINGS;
  const safeMode = mode === 'light' ? 'light' : 'dark';
  const hue = valid.hue % 360;
  const saturation = valid.saturation / 100;
  const brightness = valid.brightness / 100;
  const surfaceChroma = saturation * 0.035;
  const surfaceHue = (hue + (valid.harmony === 'triadic' ? 240 : 0)) % 360;
  const surfaceBase = safeMode === 'dark' ? 0.10 + brightness * 0.08 : 0.92 + brightness * 0.06;
  const surface = (offset: number): string => oklchHex(surfaceBase + (safeMode === 'dark' ? offset : -offset), surfaceChroma, surfaceHue);
  const text = (lightness: number): string => oklchHex(lightness, saturation * 0.02, hue);
  const accentLightness = safeMode === 'dark' ? 0.67 + brightness * 0.10 : 0.43 + brightness * 0.08;
  const accentChroma = saturation * 0.20;
  const secondaryHue = (hue + (valid.harmony === 'complementary' ? 180 : valid.harmony === 'triadic' ? 120 : 35)) % 360;
  const status = (statusHue: number): string => oklchHex(safeMode === 'dark' ? 0.72 + brightness * 0.04 : 0.40 + brightness * 0.02, 0.10 + saturation * 0.06, statusHue);
  const palette: CustomThemePalette = {
    mode: safeMode,
    bg: surface(0), gutter: surface(-0.015), panel: surface(0.045), panel2: surface(0.075), panelHi: surface(0.105), controlBg: surface(0.015),
    accent: oklchHex(accentLightness, accentChroma, hue),
    secondary: oklchHex(accentLightness, accentChroma * 0.8, secondaryHue),
    text: text(safeMode === 'dark' ? 0.95 : 0.20),
    textDim: text(safeMode === 'dark' ? 0.80 : 0.32),
    textFaint: text(safeMode === 'dark' ? 0.68 : 0.42),
    bad: status(25), good: status(145), review: status(255), queued: status(95),
  };
  return { ...palette, ...(recipe?.overrides ?? {}) };
}

export function themeGeneratorBootstrapSource(): string {
  const serialize = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
  return `const DEFAULT_THEME_GENERATOR_SETTINGS = ${serialize(DEFAULT_THEME_GENERATOR_SETTINGS)};
    const THEME_OVERRIDE_KEYS = ${serialize(THEME_OVERRIDE_KEYS)};
    ${parseThemeGeneratorRecipe.toString()}
    ${linearRgb.toString()}
    ${oklchHex.toString()}
    ${generateThemePalette.toString()}`;
}

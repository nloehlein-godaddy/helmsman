import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette, parseThemeGeneratorRecipe, themeGeneratorBootstrapSource, type ThemeGeneratorRecipe } from './themeGenerator';
export type { ThemeGeneratorSettings, ThemeGeneratorRecipe } from './themeGenerator';

export type ThemeMode = 'dark' | 'light';

export interface Theme {
  id: string;
  label: string;
  mode: ThemeMode;
  vars: Record<string, string>;
}

export const DEFAULT_THEME_ID = 'custom';

export const CUSTOM_THEME_ID = 'custom';
export const CUSTOM_THEME_STORAGE_KEY = 'cmux.theme.custom';
export const DEFAULT_THEME_BACKGROUND = generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark').bg;

export const REQUIRED_VAR_KEYS: readonly string[] = [
  '--section-nav-bg',
  '--section-nav-hover',
  '--section-nav-text',
  '--section-nav-selected',
  '--section-nav-ink',
  '--nav-bg',
  '--nav-text',
  '--nav-muted',
  '--nav-active',
  '--bg',
  '--gutter',
  '--panel',
  '--panel-2',
  '--panel-hi',
  '--control-bg',
  '--input-text',
  '--input-placeholder',
  '--input-accent',
  '--control-border',
  '--line',
  '--line-strong',
  '--line-faint',
  '--secondary',
  '--secondary-text',
  '--on-accent',
  '--on-good',
  '--accent',
  '--accent-text',
  '--accent-text-hover',
  '--accent-bright',
  '--accent-dim',
  '--accent-plate',
  '--text',
  '--text-dim',
  '--text-faint',
  '--bad',
  '--good',
  '--review',
  '--queued',
];

interface ThemeAnchors {
  id: string;
  label: string;
  mode: ThemeMode;
  bg: string;
  gutter: string;
  panel: string;
  panel2: string;
  panelHi: string;
  accent: string;
  secondary: string;
  text: string;
  textDim: string;
  textFaint: string;
  bad: string;
  good: string;
  review: string;
  queued: string;
}

export type CustomThemePalette = Omit<ThemeAnchors, 'id' | 'label'> & { controlBg: string };

export const CUSTOM_THEME_FIELDS = [
  { key: 'bg', label: 'Background' },
  { key: 'gutter', label: 'Navigation' },
  { key: 'panel', label: 'Panel' },
  { key: 'panel2', label: 'Secondary panel' },
  { key: 'panelHi', label: 'Highlighted panel' },
  { key: 'controlBg', label: 'Input background' },
  { key: 'accent', label: 'Accent' },
  { key: 'secondary', label: 'Secondary accent' },
  { key: 'text', label: 'Text' },
  { key: 'textDim', label: 'Secondary text' },
  { key: 'textFaint', label: 'Muted text' },
  { key: 'bad', label: 'Error' },
  { key: 'good', label: 'Success' },
  { key: 'review', label: 'Review' },
  { key: 'queued', label: 'Queued' },
] as const satisfies readonly { key: keyof Omit<CustomThemePalette, 'mode'>; label: string }[];

function parseCustomThemePalette(value: unknown): CustomThemePalette | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.mode !== 'dark' && record.mode !== 'light') return undefined;
  const colorKeys = CUSTOM_THEME_FIELDS.map(field => field.key);
  const allowedKeys: readonly string[] = ['mode', ...colorKeys];
  const keys = Object.keys(record);
  if (keys.length !== allowedKeys.length || keys.some(key => !allowedKeys.includes(key))) return undefined;
  for (const key of colorKeys) {
    if (typeof record[key] !== 'string' || !/^#[a-f\d]{6}$/i.test(record[key])) return undefined;
  }
  const palette = Object.fromEntries(['mode', ...colorKeys].map(key => [key, record[key]]));
  return palette as unknown as CustomThemePalette;
}

function parseStoredThemeRecipe(raw: string | null, generate: typeof generateThemePalette, parseRecipe: typeof parseThemeGeneratorRecipe): { palette: CustomThemePalette; recipe: ThemeGeneratorRecipe } | undefined {
  if (!raw) return undefined;
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
    const record = stored as Record<string, unknown>;
    if (record.version !== 3 || Object.keys(record).length !== 3) return undefined;
    const palette = parseCustomThemePalette(record.palette);
    const recipe = parseRecipe(record.recipe);
    if (!palette || !recipe) return undefined;
    const generated = generate(recipe.settings, palette.mode, recipe.overrides, recipe.sourcePalette);
    if (Object.keys(generated).some(key => palette[key as keyof CustomThemePalette] !== generated[key as keyof CustomThemePalette])) return undefined;
    return { palette, recipe };
  } catch {
    return undefined;
  }
}

function parseStoredCustomTheme(raw: string | null, generate: typeof generateThemePalette, parseRecipe: typeof parseThemeGeneratorRecipe): CustomThemePalette | undefined {
  return parseStoredThemeRecipe(raw, generate, parseRecipe)?.palette;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean: string = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixHex(hex: string, target: number, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c: number): string => Math.round(c + (target - c) * amount).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channels = [r, g, b].map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function colorContrast(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first); const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function readableText(color: string, surfaces: readonly string[]): string {
  const surfaceLuminances = surfaces.map(relativeLuminance);
  const score = (candidate: string): number => {
    const luminance = relativeLuminance(candidate);
    return Math.min(...surfaceLuminances.map(surface => (Math.max(luminance, surface) + 0.05) / (Math.min(luminance, surface) + 0.05)));
  };
  if (score(color) >= 4.5) return color;
  const channels = Object.values(hexToRgb(color));
  const distance = (candidate: string): number => Object.values(hexToRgb(candidate)).reduce((sum, channel, index) => sum + (channel - channels[index]!) ** 2, 0);
  let best = color;
  let bestScore = score(color);
  const passing: string[] = [];
  for (const target of [0, 255]) {
    const amounts = new Set<number>([1]);
    for (const channel of channels) {
      const steps = Math.abs(target - channel);
      for (let step = 0; step < steps; step++) amounts.add((step + 0.5) / steps + 1e-10);
    }
    for (const amount of [...amounts].sort((first, second) => first - second)) {
      const candidate = mixHex(color, target, Math.min(amount, 1));
      const candidateScore = score(candidate);
      if (candidateScore >= 4.5) {
        passing.push(candidate);
        break;
      }
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
  }
  return passing.sort((first, second) => distance(first) - distance(second))[0] ?? best;
}

function filledInk(fill: string, preferred: string): string {
  if (colorContrast(preferred, fill) >= 4.5) return preferred;
  return colorContrast('#ffffff', fill) >= colorContrast('#000000', fill) ? '#ffffff' : '#000000';
}

function sectionNavVars(accent: string, companion: string, surfaces: readonly string[]): Record<string, string> {
  const separation = (color: string) => Math.min(...surfaces.map(surface => colorContrast(color, surface)));
  const background = separation(companion) >= separation(accent) ? companion : accent;
  const ink = colorContrast(background, '#000000') >= colorContrast(background, '#ffffff') ? '#000000' : '#ffffff';
  return {
    '--section-nav-bg': background,
    '--section-nav-hover': mixHex(background, ink === '#000000' ? 255 : 0, 0.12),
    '--section-nav-text': ink,
    '--section-nav-selected': ink,
    '--section-nav-ink': background,
  };
}

function deriveVars(anchors: ThemeAnchors & { controlBg?: string }): Record<string, string> {
  const navigation = anchors.gutter;
  const controlBackground = anchors.controlBg ?? mixHex(anchors.panel, 0, anchors.mode === 'light' ? 0.1 : 0.65);
  const surfaces = [anchors.bg, anchors.gutter, anchors.panel, anchors.panel2, anchors.panelHi];
  const text = (color: string): string => anchors.id === CUSTOM_THEME_ID ? readableText(color, surfaces) : color;
  const accentText = text(anchors.accent);
  const accentHover = mixHex(accentText, anchors.mode === 'light' ? 0 : 255, 0.15);
  const preferredInk = anchors.mode === 'light' ? '#ffffff' : '#08090c';
  return {
    ...sectionNavVars(anchors.accent, anchors.secondary, [navigation, anchors.gutter, anchors.bg, anchors.panel]),
    '--nav-bg': navigation,
    '--nav-text': readableText(anchors.text, [navigation, anchors.panelHi]),
    '--nav-muted': readableText(anchors.textDim, [navigation, anchors.panelHi]),
    '--nav-active': anchors.panelHi,
    '--bg': anchors.bg,
    '--gutter': anchors.gutter,
    '--panel': anchors.panel,
    '--panel-2': anchors.panel2,
    '--panel-hi': anchors.panelHi,
    '--control-bg': controlBackground,
    '--input-text': readableText(anchors.text, [controlBackground]),
    '--input-placeholder': readableText(anchors.textDim, [controlBackground]),
    '--input-accent': readableText(anchors.accent, [controlBackground]),
    '--control-border': mixHex(anchors.textDim, 0, anchors.mode === 'light' ? 0.05 : 0.18),
    '--line': rgbaFromHex(anchors.textDim, 0.32),
    '--line-strong': rgbaFromHex(anchors.textDim, anchors.mode === 'light' ? 0.76 : 0.72),
    '--line-faint': rgbaFromHex(anchors.textDim, 0.18),
    '--secondary': anchors.secondary,
    '--secondary-text': text(anchors.secondary),
    '--on-accent': filledInk(anchors.accent, preferredInk),
    '--on-good': filledInk(anchors.good, preferredInk),
    '--accent': anchors.accent,
    '--accent-text': accentText,
    '--accent-text-hover': anchors.id === CUSTOM_THEME_ID ? readableText(accentHover, surfaces) : accentHover,
    '--accent-bright': mixHex(anchors.accent, anchors.mode === 'light' ? 0 : 255, 0.15),
    '--accent-dim': rgbaFromHex(anchors.accent, 0.55),
    '--accent-plate': anchors.accent,
    '--text': text(anchors.text),
    '--text-dim': text(anchors.textDim),
    '--text-faint': text(anchors.textFaint),
    '--bad': anchors.bad,
    '--good': anchors.good,
    '--review': anchors.review,
    '--queued': anchors.queued,
  };
}

export function customThemeFromPalette(palette: CustomThemePalette): Theme {
  const validPalette = parseCustomThemePalette(palette) ?? generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark');
  return { id: CUSTOM_THEME_ID, label: 'Custom', mode: validPalette.mode, vars: deriveVars({ ...validPalette, id: CUSTOM_THEME_ID, label: 'Custom' }) };
}

export function loadCustomTheme(): CustomThemePalette {
  try {
    if (typeof localStorage !== 'undefined') {
      const palette = parseStoredCustomTheme(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY), generateThemePalette, parseThemeGeneratorRecipe);
      if (palette) return palette;
    }
  } catch {}
  return generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark');
}

export function loadCustomThemeRecipe(): ThemeGeneratorRecipe | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return parseStoredThemeRecipe(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY), generateThemePalette, parseThemeGeneratorRecipe)?.recipe;
  } catch {
    return undefined;
  }
}

export function saveCustomTheme(palette: CustomThemePalette, recipe?: ThemeGeneratorRecipe): boolean {
  const validPalette = parseCustomThemePalette(palette);
  const validRecipe = parseThemeGeneratorRecipe(recipe);
  if (!validPalette || !validRecipe) return false;
  const generated = generateThemePalette(validRecipe.settings, validPalette.mode, validRecipe.overrides, validRecipe.sourcePalette);
  if (Object.keys(generated).some(key => validPalette[key as keyof CustomThemePalette] !== generated[key as keyof CustomThemePalette])) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify({ version: 3, palette: validPalette, recipe: validRecipe }));
    return true;
  } catch {
    return false;
  }
}

export function customThemeBootstrapSource(): string {
  const serialize = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
  return `const CUSTOM_THEME_FIELDS = ${serialize(CUSTOM_THEME_FIELDS)};
    const CUSTOM_THEME_ID = ${serialize(CUSTOM_THEME_ID)};
    ${parseCustomThemePalette.toString()}
    ${themeGeneratorBootstrapSource()}
    ${parseStoredThemeRecipe.toString()}
    ${parseStoredCustomTheme.toString()}
    ${hexToRgb.toString()}
    ${rgbaFromHex.toString()}
    ${mixHex.toString()}
    ${relativeLuminance.toString()}
    ${colorContrast.toString()}
    ${readableText.toString()}
    ${filledInk.toString()}
    ${sectionNavVars.toString()}
    ${deriveVars.toString()}
    let palette = ${serialize(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark'))};
    try { palette = parseStoredCustomTheme(localStorage.getItem(${serialize(CUSTOM_THEME_STORAGE_KEY)}), generateThemePalette, parseThemeGeneratorRecipe) || palette; } catch {}
    const customTheme = { id: ${serialize(CUSTOM_THEME_ID)}, label: 'Custom', mode: palette.mode, vars: deriveVars({ ...palette, id: ${serialize(CUSTOM_THEME_ID)}, label: 'Custom' }) };`;
}

export function applyThemeToDocument(theme: Theme, keys: readonly string[], fallbackBackground: string): void {
  const root: HTMLElement = document.documentElement;
  for (const key of keys) {
    const value: string | undefined = theme.vars[key];
    if (value) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  }
  root.dataset.theme = theme.id;
  root.dataset.themeMode = theme.mode;
  root.style.colorScheme = theme.mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.vars['--bg'] ?? fallbackBackground);
}

export function applyCustomTheme(palette: CustomThemePalette): void {
  if (typeof document === 'undefined') return;
  applyThemeToDocument(customThemeFromPalette(palette), REQUIRED_VAR_KEYS, DEFAULT_THEME_BACKGROUND);
}

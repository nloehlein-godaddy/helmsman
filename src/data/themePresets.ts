import type { FiveColorPalette } from './themeGenerator';

export interface ThemePalettePreset {
  id: string;
  name: string;
  colors: FiveColorPalette;
}

export const THEME_PALETTE_PRESETS: readonly ThemePalettePreset[] = [];

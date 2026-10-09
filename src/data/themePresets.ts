import type { FiveColorPalette } from './themeGenerator';

export interface ThemePalettePreset {
  id: string;
  name: string;
  colors: FiveColorPalette;
}

export const THEME_PALETTE_PRESETS: readonly ThemePalettePreset[] = [
  { id: 'ember-tide', name: 'Ember Tide', colors: ['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc'] },
  { id: 'olive-copper', name: 'Olive & Copper', colors: ['#606c38', '#283618', '#fefae0', '#dda15e', '#bc6c25'] },
  { id: 'festival', name: 'Festival', colors: ['#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff'] },
  { id: 'spring-tide', name: 'Spring Tide', colors: ['#3c1642', '#086375', '#1dd3b0', '#affc41', '#b2ff9e'] },
  { id: 'daydream', name: 'Daydream', colors: ['#cdb4db', '#ffc8dd', '#ffafcc', '#bde0fe', '#a2d2ff'] },
];

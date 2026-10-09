import { CUSTOM_THEME_FIELDS, loadCustomTheme, loadCustomThemeRecipe, type CustomThemePalette } from './data/themes';
import { DEFAULT_THEME_GENERATOR_SETTINGS, THEME_HARMONIES, type ThemeGeneratorRecipe } from './data/themeGenerator';
import { THEME_PALETTE_PRESETS } from './data/themePresets';
import { renderThemeModeIcon } from './renderThemeModeIcon';
import { escapeHtml as esc } from './logic/html';

export interface CustomThemeEditorState {
  palette: CustomThemePalette;
  recipe: ThemeGeneratorRecipe;
  dirty: boolean;
  message: string | null;
  error: boolean;
}

export const CUSTOM_THEME_OVERRIDE_FIELDS = CUSTOM_THEME_FIELDS.filter(field => !['bad', 'good', 'review', 'queued'].includes(field.key));

export function renderCustomThemeEditor(state?: CustomThemeEditorState): string {
  const current = state ?? { palette: loadCustomTheme(), recipe: loadCustomThemeRecipe() ?? { settings: { ...DEFAULT_THEME_GENERATOR_SETTINGS }, overrides: {} }, dirty: false, message: null, error: false };
  const sliders = ([['hue', 'Hue', 360, '°'], ['saturation', 'Saturation', 100, '%'], ['brightness', 'Brightness', 100, '%']] as const).map(([key, label, max, unit]) => `<div class="custom-theme-slider"><div><label for="custom-theme-${key}">${label}</label><output for="custom-theme-${key}" data-custom-theme-setting-output="${key}">${current.recipe.settings[key]}${unit}</output></div><input type="range" id="custom-theme-${key}" min="0" max="${max}" step="1" value="${current.recipe.settings[key]}" data-custom-theme-setting="${key}"></div>`).join('');
  return `<div class="custom-theme-editor">
    <div class="custom-theme-heading"><h3>Your theme</h3><p>Choose a base color. Surfaces, accents, and readable text update together. Save to keep your changes in this browser.</p></div>
    ${THEME_PALETTE_PRESETS.length ? `<div class="custom-theme-presets"><label for="custom-theme-preset">Palette preset</label><select id="custom-theme-preset" data-custom-theme-preset><option value="">Generated palette</option>${THEME_PALETTE_PRESETS.map(preset => `<option value="${esc(preset.id)}"${current.recipe.sourcePalette?.every((color, index) => color.toLowerCase() === preset.colors[index]?.toLowerCase()) ? ' selected' : ''}>${esc(preset.name)}</option>`).join('')}</select></div>` : ''}
    <div class="custom-theme-generator">${sliders}</div>
    <div class="custom-theme-controls">
      <div><label for="custom-theme-harmony">Color harmony</label><div class="custom-theme-harmony-row"><select id="custom-theme-harmony" data-custom-theme-harmony>${THEME_HARMONIES.filter(({ value }) => value !== 'palette' || current.recipe.sourcePalette).map(({ value, label }) => `<option value="${value}"${current.recipe.settings.harmony === value ? ' selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="custom-theme-mode" data-custom-theme-mode aria-label="Dark appearance" aria-pressed="${current.palette.mode === 'dark'}" title="Switch to ${current.palette.mode === 'dark' ? 'light' : 'dark'} appearance">${renderThemeModeIcon(current.palette.mode)}</button></div></div>
    </div>
    <p>Errors stay red, success green, review blue, and queued yellow.</p>
    <details class="custom-theme-advanced"><summary>Advanced color overrides</summary><div class="custom-theme-advanced-body"><p>Override individual colors. Your overrides stay in place when you adjust the base color.</p>
    <fieldset class="custom-theme-colors"><legend class="sr-only">Color overrides</legend>${CUSTOM_THEME_OVERRIDE_FIELDS.map(({ key, label }) => `<div class="custom-theme-color"><label for="custom-theme-${esc(key)}">${esc(label)}</label><div><input type="color" id="custom-theme-${esc(key)}" data-custom-theme-color="${esc(key)}" value="${esc(current.palette[key])}"><output for="custom-theme-${esc(key)}">${esc(current.palette[key])}</output></div></div>`).join('')}</fieldset>
    <button type="button" data-custom-theme-reset-overrides${Object.keys(current.recipe.overrides).length ? '' : ' disabled'}>Reset overrides</button></div></details>
    <div class="custom-theme-actions"><button type="button" data-custom-theme-save>Save theme</button><button type="button" data-custom-theme-discard${current.dirty ? '' : ' disabled'}>Discard changes</button><button type="button" data-custom-theme-reset>Reset theme</button></div>
    <p data-custom-theme-status role="${current.error ? 'alert' : 'status'}"${current.message ? '' : ' hidden'}>${esc(current.message ?? '')}</p>
  </div>`;
}

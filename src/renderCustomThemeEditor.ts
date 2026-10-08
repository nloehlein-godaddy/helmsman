import { CUSTOM_THEME_FIELDS, CUSTOM_THEME_ID, DEFAULT_THEME_ID, loadCustomTheme, THEMES, type CustomThemePalette } from './data/themes';
import { escapeHtml as esc } from './logic/html';

export interface CustomThemeEditorState {
  palette: CustomThemePalette;
  presetId: string;
  dirty: boolean;
  message: string | null;
  error: boolean;
}

export function renderCustomThemeEditor(state?: CustomThemeEditorState): string {
  const current = state ?? { palette: loadCustomTheme(), presetId: DEFAULT_THEME_ID, dirty: false, message: null, error: false };
  const presets = THEMES.filter(theme => theme.id !== CUSTOM_THEME_ID && theme.id !== 'amber').map(theme =>
    `<option value="${esc(theme.id)}"${theme.id === current.presetId ? ' selected' : ''}>${esc(theme.label)}</option>`).join('');
  return `<div class="custom-theme-editor">
    <div class="custom-theme-heading"><h3>Custom theme</h3><p>One personal palette, saved in this browser. Changes preview immediately; save to keep them.</p></div>
    <div class="custom-theme-controls">
      <div class="custom-theme-preset"><label for="custom-theme-preset">Start from</label><div><select id="custom-theme-preset" data-custom-theme-preset>${presets}</select><button type="button" data-custom-theme-use-preset>Use preset</button></div></div>
      <div><label for="custom-theme-mode">Appearance</label><select id="custom-theme-mode" data-custom-theme-mode><option value="dark"${current.palette.mode === 'dark' ? ' selected' : ''}>Dark</option><option value="light"${current.palette.mode === 'light' ? ' selected' : ''}>Light</option></select></div>
    </div>
    <fieldset class="custom-theme-colors"><legend>Palette colors</legend>${CUSTOM_THEME_FIELDS.map(({ key, label }) => `<div class="custom-theme-color"><label for="custom-theme-${esc(key)}">${esc(label)}</label><div><input type="color" id="custom-theme-${esc(key)}" data-custom-theme-color="${esc(key)}" value="${esc(current.palette[key])}"><output for="custom-theme-${esc(key)}">${esc(current.palette[key])}</output></div></div>`).join('')}</fieldset>
    <div class="custom-theme-actions"><button type="button" data-custom-theme-save>Save custom theme</button><button type="button" data-custom-theme-discard${current.dirty ? '' : ' disabled'}>Discard changes</button></div>
    <p data-custom-theme-status role="${current.error ? 'alert' : 'status'}"${current.message ? '' : ' hidden'}>${esc(current.message ?? '')}</p>
  </div>`;
}

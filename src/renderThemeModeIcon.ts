import type { ThemeMode } from './data/themes';

export function renderThemeModeIcon(mode: ThemeMode): string {
  const icon = mode === 'dark' ? 'moon' : 'sun';
  return `<svg viewBox="0 0 256 256" aria-hidden="true" focusable="false" fill="currentColor"><use href="/icons/theme-mode.svg#${icon}"></use></svg>`;
}

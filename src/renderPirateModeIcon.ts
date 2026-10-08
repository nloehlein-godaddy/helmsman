export function renderPirateModeIcon(enabled: boolean): string {
  const icon = enabled ? 'treasure-chest' : 'briefcase';
  return `<svg class="pirate-mode-icon" viewBox="0 0 256 256" data-pirate-icon="${icon}" aria-hidden="true" focusable="false" fill="currentColor"><use href="/icons/pirate-mode.svg#${icon}"></use></svg>`;
}

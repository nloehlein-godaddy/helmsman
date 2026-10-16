const glyphs = {
  'chat-circle-text': '\ue16e',
  'paper-plane-tilt': '\ue398',
  'info': '\ue2ce',
  'warning-circle': '\ue4e2',
  'arrow-clockwise': '\ue036',
  'x': '\ue4f6',
  'arrow-counter-clockwise': '\ue038',
  'terminal-window': '\ueae8',
  'pause': '\ue39e',
  'arrow-line-down': '\ue05c',
  'clock-counter-clockwise': '\ue1a0',
  'copy': '\ue1ca',
  'fingerprint': '\ue23e',
  'download-simple': '\ue20c',
  'stop': '\ue46c',
  'arrow-square-out': '\ue5de',
  'check-circle': '\ue184',
  'currency-dollar': '\ue550',
  'git-branch': '\ue278',
  'caret-right': '\ue13a',
  'arrows-out-line-vertical': '\ue536',
  'dots-six': '\ue794',
  'robot': '\ue762',
  'tray': '\ue4aa',
  'check': '\ue182',
  'x-circle': '\ue4f8',
  'receipt': '\ue3ec',
  'sliders-horizontal': '\ue434',
  'magnifying-glass': '\ue30c',
} as const;
export type IconName = keyof typeof glyphs;
export function icon(name: IconName): HTMLSpanElement {
  const element = document.createElement('span'); element.className = 'run-icon'; element.dataset.icon = name;
  element.dataset.glyph = glyphs[name]; element.setAttribute('aria-hidden', 'true'); return element;
}

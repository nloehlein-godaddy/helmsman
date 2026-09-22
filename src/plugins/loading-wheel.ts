export const loadingWheelStylesV1 = `.helmsman-loading-wheel-v1{display:inline-flex;align-items:center;gap:.55rem;max-width:100%;color:var(--text-dim,#667085);font:inherit;line-height:1.4}.helmsman-loading-wheel-v1__graphic{width:1.5rem;height:1.5rem;flex:0 0 auto;color:var(--accent,#2563eb);animation:helmsman-loading-wheel-v1-turn 1.2s linear infinite}.helmsman-loading-wheel-v1__ring{fill:none;stroke:currentColor;stroke-width:3}.helmsman-loading-wheel-v1__spoke{stroke:currentColor;stroke-width:3;stroke-linecap:round}.helmsman-loading-wheel-v1__hub{fill:currentColor}.helmsman-loading-wheel-v1__label{min-width:0;overflow-wrap:anywhere}@keyframes helmsman-loading-wheel-v1-turn{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.helmsman-loading-wheel-v1__graphic{animation:none}}`;

export interface LoadingWheelOptionsV1 {
  readonly label?: string;
}

export function createLoadingWheelV1(message: string, options?: LoadingWheelOptionsV1): HTMLElement {
  const root = document.createElement('span');
  root.className = 'helmsman-loading-wheel-v1';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-busy', 'true');

  const style = document.createElement('style');
  style.textContent = loadingWheelStylesV1;
  const graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  graphic.classList.add('helmsman-loading-wheel-v1__graphic');
  graphic.setAttribute('viewBox', '0 0 32 32');
  graphic.setAttribute('aria-hidden', 'true');
  graphic.setAttribute('focusable', 'false');
  const ring = document.createElementNS(graphic.namespaceURI, 'circle');
  ring.classList.add('helmsman-loading-wheel-v1__ring');
  ring.setAttribute('cx', '16'); ring.setAttribute('cy', '16'); ring.setAttribute('r', '11');
  const hub = document.createElementNS(graphic.namespaceURI, 'circle');
  hub.classList.add('helmsman-loading-wheel-v1__hub');
  hub.setAttribute('cx', '16'); hub.setAttribute('cy', '16'); hub.setAttribute('r', '3');
  graphic.append(ring);
  for (const [x1, y1, x2, y2] of [[16, 2, 16, 11], [30, 16, 21, 16], [16, 30, 16, 21], [2, 16, 11, 16]] as const) {
    const spoke = document.createElementNS(graphic.namespaceURI, 'line');
    spoke.classList.add('helmsman-loading-wheel-v1__spoke');
    spoke.setAttribute('x1', String(x1)); spoke.setAttribute('y1', String(y1)); spoke.setAttribute('x2', String(x2)); spoke.setAttribute('y2', String(y2));
    graphic.append(spoke);
  }
  const label = document.createElement('span');
  label.className = 'helmsman-loading-wheel-v1__label';
  label.textContent = typeof options?.label === 'string' && options.label.trim() ? options.label : typeof message === 'string' && message.trim() ? message : 'Loading…';
  root.append(style, graphic, label);
  return root;
}

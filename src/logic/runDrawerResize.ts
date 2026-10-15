import { term } from './terminology';

export const RUN_DRAWER_HEIGHT_KEY = 'helmsman.runDrawerHeight';

export function createRunDrawerResize(root: HTMLElement, signal: AbortSignal) {
  let preference: number | null = null;
  let drag: { pointerId: number; y: number; height: number; preference: number | null; handle: HTMLElement } | null = null;
  try {
    const saved = localStorage.getItem(RUN_DRAWER_HEIGHT_KEY);
    const value = saved === null ? NaN : Number(saved);
    if (Number.isFinite(value) && value >= 80 && value <= 10_000) preference = value;
  } catch {}
  const drawer = () => root.querySelector<HTMLDetailsElement>('.plugin-auxiliary-slot');
  function bounds() {
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const reserved = ['.helm-head', '.page-tabs', '.section-nav', '.app-footer'].reduce((height, selector) => {
      const element = root.querySelector<HTMLElement>(selector);
      const rect = element?.getBoundingClientRect();
      return height + (element && !element.hidden && rect && (selector !== '.page-tabs' || root.querySelector('.page-tabs')?.getAttribute('aria-orientation') === 'horizontal') ? rect.height : 0);
    }, 0);
    const summary = drawer()?.querySelector('summary')?.getBoundingClientRect().height ?? 0;
    const maximum = Math.max(80, Math.min(viewport * .7, viewport - reserved - summary - 24 - 120));
    return { minimum: Math.min(180, maximum), maximum, fallback: viewport * .4 };
  }
  function sync() {
    const slot = drawer(); const handle = slot?.querySelector<HTMLElement>('[data-run-drawer-resize]');
    if (!slot || !handle) return;
    const { minimum, maximum, fallback } = bounds();
    const height = Math.round(Math.max(minimum, Math.min(maximum, preference ?? fallback)));
    slot.style.setProperty('--run-drawer-height', `${height}px`);
    handle.setAttribute('aria-label', term('resizeRunLogs'));
    handle.setAttribute('aria-valuemin', String(Math.round(minimum)));
    handle.setAttribute('aria-valuemax', String(Math.round(maximum)));
    handle.setAttribute('aria-valuenow', String(height));
    handle.setAttribute('aria-valuetext', `${height} pixels`);
    handle.title = term('resizeRunLogs');
  }
  function change(height: number, save: boolean) {
    const { minimum, maximum } = bounds(); preference = Math.round(Math.max(minimum, Math.min(maximum, height))); sync();
    if (save) { try { localStorage.setItem(RUN_DRAWER_HEIGHT_KEY, String(preference)); } catch {} }
  }
  function finish(save: boolean) {
    const current = drag; if (!current) return; drag = null;
    drawer()?.removeAttribute('data-resizing');
    if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    if (save) change(preference ?? current.height, true);
    else { preference = current.preference; sync(); }
  }
  root.addEventListener('pointerdown', event => {
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-run-drawer-resize]') : null;
    const slot = drawer(); if (!handle || !slot?.open || slot.hidden || event.button !== 0 || drag) return;
    event.preventDefault(); sync(); handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, y: event.clientY, height: Number(handle.getAttribute('aria-valuenow')), preference, handle };
    slot.dataset.resizing = ''; handle.setPointerCapture?.(event.pointerId);
  }, { signal });
  window.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drawer()?.open || drawer()?.hidden) { finish(false); return; }
    event.preventDefault(); change(drag.height + drag.y - event.clientY, false);
  }, { signal, passive: false });
  window.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finish(true); }, { signal });
  window.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) finish(false); }, { signal });
  root.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) finish(false); }, { signal });
  root.addEventListener('keydown', event => {
    const handle = event.target instanceof HTMLElement && event.target.matches('[data-run-drawer-resize]') ? event.target : null;
    const slot = drawer(); if (!handle || !slot?.open || slot.hidden) return;
    const { minimum, maximum } = bounds(); const height = Number(handle.getAttribute('aria-valuenow'));
    const next = event.key === 'Home' ? minimum : event.key === 'End' ? maximum : event.key === 'ArrowUp' ? height + (event.shiftKey ? 64 : 24)
      : event.key === 'ArrowDown' ? height - (event.shiftKey ? 64 : 24) : null;
    if (next !== null) { event.preventDefault(); change(next, true); }
    else if (event.key === 'Escape' && drag) { event.preventDefault(); finish(false); }
  }, { signal });
  window.visualViewport?.addEventListener('resize', sync, { signal });
  signal.addEventListener('abort', () => { finish(false); }, { once: true });
  return { sync };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunDrawerResize, RUN_DRAWER_HEIGHT_KEY } from './runDrawerResize';

const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(controller => controller.abort()); localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  const root = document.createElement('div'); root.innerHTML = '<details class="plugin-auxiliary-slot" open><summary>Run logs</summary><div role="separator" tabindex="0" data-run-drawer-resize></div><div data-run-viewer-host><pre>Retained log</pre></div></details>'; document.body.append(root);
  const lifetime = new AbortController(); lifetimes.push(lifetime); const control = createRunDrawerResize(root, lifetime.signal); control.sync();
  const slot = root.querySelector<HTMLDetailsElement>('details')!; const handle = root.querySelector<HTMLElement>('[role=separator]')!; const log = root.querySelector('pre')!;
  const height = () => Number(handle.getAttribute('aria-valuenow'));
  const key = (value: string, shiftKey = false) => handle.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
  const pointer = (target: EventTarget, type: string, y: number, pointerId = 1) => {
    const event = new MouseEvent(type, { button: 0, clientY: y, bubbles: true, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: pointerId }); target.dispatchEvent(event);
  };
  return { root, lifetime, control, slot, handle, log, height, key, pointer };
}
describe('run log drawer resizing', () => {
  it('supports keyboard sizing and persists it without replacing the log or changing scope', () => {
    const f = fixture(); const original = f.height(); const url = window.location.href;
    f.handle.focus(); f.key('ArrowUp'); expect(f.height()).toBe(original + 24); f.key('ArrowDown', true); expect(f.height()).toBe(original - 40);
    f.key('Home'); expect(f.height()).toBe(Number(f.handle.getAttribute('aria-valuemin')));
    f.key('End'); expect(f.height()).toBe(Number(f.handle.getAttribute('aria-valuemax')));
    expect(localStorage.getItem(RUN_DRAWER_HEIGHT_KEY)).toBe(String(f.height())); expect(f.root.querySelector('pre')).toBe(f.log); expect(f.log.isConnected).toBe(true); expect(document.activeElement).toBe(f.handle); expect(window.location.href).toBe(url);
    const saved = f.height(); f.lifetime.abort(); expect(fixture().height()).toBe(saved);
  });
  it('expands when dragged up, saves only on release, and ignores unrelated pointers', () => {
    const f = fixture(); const original = f.height(); f.pointer(f.handle, 'pointerdown', 400); f.pointer(window, 'pointermove', 350, 2); expect(f.height()).toBe(original);
    f.pointer(window, 'pointermove', 350); expect(f.height()).toBe(original + 50); expect(localStorage.getItem(RUN_DRAWER_HEIGHT_KEY)).toBeNull();
    f.pointer(window, 'pointerup', 350); expect(localStorage.getItem(RUN_DRAWER_HEIGHT_KEY)).toBe(String(original + 50)); expect(f.slot.hasAttribute('data-resizing')).toBe(false); expect(f.root.querySelector('pre')).toBe(f.log);
  });
  it('restores the previous preference on cancellation and disposes pointer handlers', () => {
    const f = fixture(); const original = f.height(); f.key('ArrowUp'); const saved = localStorage.getItem(RUN_DRAWER_HEIGHT_KEY);
    f.pointer(f.handle, 'pointerdown', 400); f.pointer(window, 'pointermove', 200); expect(f.height()).toBeGreaterThan(original + 24); f.pointer(window, 'pointercancel', 200);
    expect(f.height()).toBe(original + 24); expect(localStorage.getItem(RUN_DRAWER_HEIGHT_KEY)).toBe(saved);
    f.pointer(f.handle, 'pointerdown', 400); f.pointer(window, 'pointermove', 200); f.lifetime.abort(); expect(f.height()).toBe(original + 24);
    f.pointer(window, 'pointermove', 100); f.key('End'); expect(f.height()).toBe(original + 24); expect(f.slot.hasAttribute('data-resizing')).toBe(false);
  });
  it('clamps to a smaller viewport while retaining the preferred height for a larger viewport', () => {
    const viewport = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000); const f = fixture(); f.key('End'); const saved = localStorage.getItem(RUN_DRAWER_HEIGHT_KEY); expect(f.height()).toBe(700);
    viewport.mockReturnValue(400); f.control.sync(); expect(f.height()).toBe(256); expect(localStorage.getItem(RUN_DRAWER_HEIGHT_KEY)).toBe(saved);
    viewport.mockReturnValue(1000); f.control.sync(); expect(f.height()).toBe(700);
  });
  it('keeps controls inert when collapsed or hidden and tolerates unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); }); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const f = fixture(); const original = f.height(); f.slot.open = false; f.key('End'); f.pointer(f.handle, 'pointerdown', 400); expect(f.height()).toBe(original);
    f.slot.open = true; f.slot.hidden = true; f.key('End'); expect(f.height()).toBe(original);
    f.slot.hidden = false; expect(() => f.key('ArrowUp')).not.toThrow(); expect(f.height()).toBe(original + 24);
  });
});

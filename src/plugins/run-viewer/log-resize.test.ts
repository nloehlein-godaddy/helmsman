import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogResize } from './log-resize';

const controls: LogResize[] = [];
afterEach(() => { controls.splice(0).forEach(control => control.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  const log = document.createElement('pre'); document.body.append(log);
  Object.defineProperties(log, { clientHeight: { value: 420 }, scrollHeight: { value: 1000 } }); log.scrollTop = 100;
  const save = vi.fn(); const control = new LogResize(log, 420, save); controls.push(control); document.body.append(control.element);
  const key = (key: string, shiftKey = false) => control.element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, cancelable: true }));
  const pointer = (target: EventTarget, type: string, y: number, pointerId = 1) => {
    const event = new MouseEvent(type, { clientY: y, button: 0, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: pointerId }); target.dispatchEvent(event);
  };
  return { log, control, save, key, pointer };
}
describe('log preview resizing', () => {
  it('persists keyboard adjustments, bounds the height, and preserves paused scrolling', () => {
    const f = fixture(); f.key('ArrowDown'); expect(f.log.style.height).toBe('452px'); expect(f.save).toHaveBeenLastCalledWith(452);
    f.key('ArrowUp', true); expect(f.log.style.height).toBe('388px'); expect(f.log.scrollTop).toBe(100);
    f.key('Home'); expect(f.log.style.height).toBe('180px'); f.key('End'); f.key('ArrowDown'); expect(f.log.style.height).toBe('1200px');
    expect(f.control.element.getAttribute('aria-valuenow')).toBe('1200');
  });
  it('saves a pointer drag only on release and ignores other pointers', () => {
    const f = fixture(); f.pointer(f.control.element, 'pointerdown', 300); f.pointer(window, 'pointermove', 350, 2); expect(f.log.style.height).toBe('420px');
    f.pointer(window, 'pointermove', 350); expect(f.log.style.height).toBe('470px'); expect(f.save).not.toHaveBeenCalled();
    f.pointer(window, 'pointerup', 350); expect(f.save).toHaveBeenCalledExactlyOnceWith(470);
  });
  it('restores cancelled changes and disposes active drag handlers', () => {
    const f = fixture(); f.pointer(f.control.element, 'pointerdown', 300); f.pointer(window, 'pointermove', 600); f.pointer(window, 'pointercancel', 600);
    expect(f.log.style.height).toBe('420px'); expect(f.save).not.toHaveBeenCalled();
    f.pointer(f.control.element, 'pointerdown', 300); f.pointer(window, 'pointermove', 600); f.control.dispose();
    f.pointer(window, 'pointerup', 700); f.key('End'); expect(f.log.style.height).toBe('420px'); expect(f.save).not.toHaveBeenCalled();
  });
  it('adjusts from the visible height when a saved preference exceeds the viewport', () => {
    const f = fixture(); f.key('End'); vi.spyOn(f.log, 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect);
    f.key('ArrowUp'); expect(f.log.style.height).toBe('368px'); expect(f.save).toHaveBeenLastCalledWith(368);
  });
  it('keeps the tail visible when resizing a preview already at its end', () => {
    const f = fixture(); f.log.scrollTop = 580; f.key('ArrowDown'); expect(f.log.scrollTop).toBe(1000);
  });
});

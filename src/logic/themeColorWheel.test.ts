import { describe, expect, it, vi } from 'vitest';
import { createThemeColorWheel, wheelColor, wheelMarker, wheelSelection } from './themeColorWheel';
import { DEFAULT_THEME_GENERATOR_SETTINGS, oklchHex } from '../data/themeGenerator';

describe('theme color wheel geometry', () => {
  it.each([[200, 100, 0], [100, 0, 90], [0, 100, 180], [100, 200, 270]])('maps (%s, %s) to hue %s and full brightness', (x, y, hue) => {
    expect(wheelSelection(x, y, 200, 123)).toEqual({ hue, brightness: 100 });
  });

  it('retains the selected hue at the center and clamps outside the circle', () => {
    expect(wheelSelection(100, 100, 200, 123)).toEqual({ hue: 123, brightness: 0 });
    expect(wheelSelection(150, 100, 200, 123)).toEqual({ hue: 0, brightness: 50 });
    expect(wheelSelection(400, 100, 200, 123)).toEqual({ hue: 0, brightness: 100 });
  });

  it.each([[0, 0, 0, 123], [NaN, 1, 200, 123], [1, Infinity, 200, 123], [1, 1, -2, 123], [1, 1, 200, NaN]])('ignores invalid geometry', (x, y, size, hue) => {
    expect(wheelSelection(x, y, size, hue)).toBeNull();
  });

  it.each([0, 45, 90, 180, 270, 359])('maps marker position back to hue %s', hue => {
    const marker = wheelMarker({ hue, brightness: 53 });
    expect(wheelSelection(marker.x * 2, marker.y * 2, 200, 123)).toEqual({ hue, brightness: 53 });
  });

  it('renders the same gamut-mapped OKLCH hue as the generator', () => {
    expect(wheelColor(255, 50, 100)).toBe(oklchHex(0.5, 0.20, 255));
    expect(wheelColor(25, 0, 100)).toBe('#000000');
    expect(wheelColor(145, 100, 100)).toBe('#ffffff');
    expect(wheelColor(255, 50, 0)).toBe(wheelColor(25, 50, 0));
  });
});

describe('theme color wheel interaction lifecycle', () => {
  it('captures primary pointers, clamps drags outside, and stops after cancel or abort', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const root = document.createElement('div');
    root.innerHTML = '<div data-custom-theme-wheel tabindex="0"><span data-custom-theme-wheel-marker></span></div>';
    const wheel = root.querySelector<HTMLElement>('[data-custom-theme-wheel]')!;
    vi.spyOn(wheel, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 200, height: 200 } as DOMRect);
    let captured: number | null = null;
    wheel.setPointerCapture = vi.fn(id => { captured = id; });
    wheel.hasPointerCapture = vi.fn(id => captured === id);
    wheel.releasePointerCapture = vi.fn(() => { captured = null; });
    const controller = new AbortController();
    const update = vi.fn();
    const picker = createThemeColorWheel(root, controller.signal, () => DEFAULT_THEME_GENERATOR_SETTINGS, update);
    const pointer = (type: string, id: number, x: number, y: number, button = 0, isPrimary = true): void => {
      const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true });
      Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: isPrimary } });
      wheel.dispatchEvent(event);
    };
    try {
      picker.sync();
      pointer('pointerdown', 1, 210, 120, 2);
      pointer('pointerdown', 2, 210, 120, 0, false);
      expect(update).not.toHaveBeenCalled();
      pointer('pointerdown', 3, 160, 120);
      expect(captured).toBe(3);
      expect(update).toHaveBeenLastCalledWith({ hue: 0, brightness: 50 });
      pointer('pointermove', 4, 110, 20);
      expect(update).toHaveBeenCalledTimes(1);
      pointer('pointermove', 3, 110, -200);
      expect(update).toHaveBeenLastCalledWith({ hue: 90, brightness: 100 });
      pointer('pointercancel', 3, 110, 20);
      expect(captured).toBeNull();
      pointer('pointermove', 3, 110, 20);
      expect(update).toHaveBeenCalledTimes(2);
      pointer('pointerdown', 5, 110, 120);
      expect(update).toHaveBeenLastCalledWith({ hue: 165, brightness: 0 });
      controller.abort();
      expect(captured).toBeNull();
      pointer('pointermove', 5, 110, 20);
      expect(update).toHaveBeenCalledTimes(3);
    } finally {
      controller.abort();
      vi.unstubAllGlobals();
    }
  });

  it('supports keyboard precision, hue wrap, brightness limits, and abort cleanup', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-custom-theme-wheel tabindex="0"><span data-custom-theme-wheel-marker></span></div>';
    const wheel = root.querySelector<HTMLElement>('[data-custom-theme-wheel]')!;
    const controller = new AbortController();
    let settings = { ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 359, brightness: 99 };
    const changes: unknown[] = [];
    const picker = createThemeColorWheel(root, controller.signal, () => settings, selection => {
      changes.push(selection);
      settings = { ...settings, ...selection };
      picker.sync();
    });
    const key = (name: string, shiftKey = false): void => { wheel.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true })); };
    picker.sync();
    key('ArrowRight');
    expect(settings.hue).toBe(0);
    key('ArrowLeft', true);
    expect(settings.hue).toBe(350);
    key('ArrowUp', true);
    expect(settings.brightness).toBe(100);
    settings.brightness = 2;
    key('ArrowDown', true);
    expect(settings.brightness).toBe(0);
    expect(wheel.querySelector<HTMLElement>('[data-custom-theme-wheel-marker]')?.style.left).toBe('50%');
    expect(wheel.getAttribute('aria-label')).toContain('brightness 0 percent');
    controller.abort();
    key('ArrowRight');
    expect(changes).toHaveLength(4);
  });
});

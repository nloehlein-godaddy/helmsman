import { oklchHex, type ThemeGeneratorSettings } from '../data/themeGenerator';

type WheelSettings = Pick<ThemeGeneratorSettings, 'hue' | 'brightness'>;

export function wheelSelection(x: number, y: number, size: number, previousHue: number): WheelSettings | null {
  if (![x, y, size, previousHue].every(Number.isFinite) || size <= 0) return null;
  const dx = x - size / 2;
  const dy = size / 2 - y;
  const distance = Math.hypot(dx, dy);
  return {
    hue: distance < 0.5 ? previousHue : Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360) % 360,
    brightness: Math.round(Math.min(1, distance / (size / 2)) * 100),
  };
}

export function wheelMarker(settings: WheelSettings): { x: number; y: number } {
  const radians = settings.hue * Math.PI / 180;
  return { x: 50 + 50 * settings.brightness / 100 * Math.cos(radians), y: 50 - 50 * settings.brightness / 100 * Math.sin(radians) };
}

export function wheelColor(hue: number, brightness: number, saturation: number): string {
  const lightness = Math.min(100, Math.max(0, brightness)) / 100;
  return oklchHex(lightness, Math.sin(lightness * Math.PI) * Math.min(100, Math.max(0, saturation)) / 100 * 0.20, hue);
}

export function createThemeColorWheel(root: HTMLElement, signal: AbortSignal, settings: () => ThemeGeneratorSettings, update: (selection: WheelSettings) => void): { sync: () => void } {
  let wheel: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  let activePointer: number | null = null;
  let frame: number | null = null;
  let paintedSaturation = -1;
  let paintedSize = 0;
  const backingSize = (width: number): number => Math.min(256, Math.max(1, Math.round(width * Math.min(window.devicePixelRatio || 1, 2))));

  const releasePointer = (): void => {
    const pointer = activePointer;
    activePointer = null;
    if (pointer !== null && wheel?.hasPointerCapture?.(pointer)) wheel.releasePointerCapture(pointer);
  };

  const paint = (): void => {
    frame = null;
    const canvas = wheel?.querySelector<HTMLCanvasElement>('canvas');
    const width = wheel?.getBoundingClientRect().width ?? 0;
    if (!canvas || width <= 0) return;
    const size = backingSize(width);
    const saturation = settings().saturation;
    if (paintedSaturation === saturation && paintedSize === size) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = size;
    canvas.height = size;
    const pixels = context.createImageData(size, size);
    const colors = new Map<number, number[]>();
    const radius = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - radius;
        const dy = radius - y - 0.5;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        const brightness = Math.round(distance / radius * 100);
        const hue = Math.round(((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360) / 2) * 2;
        const key = brightness * 361 + hue;
        let channels = colors.get(key);
        if (!channels) {
          channels = (wheelColor(hue, brightness, saturation).slice(1).match(/.{2}/g) ?? []).map(channel => parseInt(channel, 16));
          colors.set(key, channels);
        }
        const offset = (y * size + x) * 4;
        pixels.data[offset] = channels[0] ?? 0;
        pixels.data[offset + 1] = channels[1] ?? 0;
        pixels.data[offset + 2] = channels[2] ?? 0;
        pixels.data[offset + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    paintedSaturation = saturation;
    paintedSize = size;
  };

  const schedulePaint = (): void => {
    const width = wheel?.getBoundingClientRect().width ?? 0;
    if (frame !== null || !wheel || width <= 0 || signal.aborted || paintedSaturation === settings().saturation && paintedSize === backingSize(width)) return;
    frame = window.requestAnimationFrame(paint);
  };

  const sync = (): void => {
    if (signal.aborted) return;
    const current = root.querySelector<HTMLElement>('[data-custom-theme-wheel]');
    if (wheel !== current) {
      releasePointer();
      observer?.disconnect();
      wheel = current;
      paintedSize = 0;
      if (wheel && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedulePaint);
        observer.observe(wheel);
      }
    }
    if (!wheel) return;
    const selected = settings();
    const marker = wheel.querySelector<HTMLElement>('[data-custom-theme-wheel-marker]');
    const position = wheelMarker(selected);
    if (marker) {
      marker.style.left = `${position.x}%`;
      marker.style.top = `${position.y}%`;
    }
    wheel.setAttribute('aria-label', `Color wheel: hue ${selected.hue} degrees, brightness ${selected.brightness} percent`);
    schedulePaint();
  };

  const selectAtPointer = (event: PointerEvent): void => {
    const rect = wheel?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const selection = wheelSelection(event.clientX - rect.left, (event.clientY - rect.top) * rect.width / rect.height, rect.width, settings().hue);
    if (selection) update(selection);
  };

  root.addEventListener('pointerdown', event => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-custom-theme-wheel]') || event.button !== 0 || event.isPrimary === false || activePointer !== null) return;
    sync();
    if (!wheel) return;
    event.preventDefault();
    wheel.focus({ preventScroll: true });
    activePointer = event.pointerId;
    wheel.setPointerCapture?.(event.pointerId);
    selectAtPointer(event);
  }, { signal });
  root.addEventListener('pointermove', event => {
    if (activePointer === null || event.pointerId !== activePointer) return;
    event.preventDefault();
    selectAtPointer(event);
  }, { signal });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    root.addEventListener(type, event => {
      if (event.pointerId === activePointer) releasePointer();
    }, { signal });
  }
  root.addEventListener('keydown', event => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-custom-theme-wheel]')) return;
    const selected = settings();
    const step = event.shiftKey ? 10 : 1;
    const hue = event.key === 'ArrowRight' ? (selected.hue + step) % 360 : event.key === 'ArrowLeft' ? (selected.hue - step + 360) % 360 : selected.hue;
    const brightness = event.key === 'ArrowUp' ? Math.min(100, selected.brightness + step) : event.key === 'ArrowDown' ? Math.max(0, selected.brightness - step) : selected.brightness;
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    update({ hue, brightness });
  }, { signal });
  window.addEventListener('resize', schedulePaint, { signal });
  signal.addEventListener('abort', () => {
    releasePointer();
    observer?.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
  }, { once: true });
  return { sync };
}

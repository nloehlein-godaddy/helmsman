import { icon } from './icons.js';

export class LogResize {
  readonly element = document.createElement('div');
  private height: number;
  private disposed = false;
  private drag: { y: number; height: number; saved: number; pointer: number } | null = null;
  private readonly log: HTMLElement;
  private readonly save: (height: number) => void;
  constructor(log: HTMLElement, height: number, save: (height: number) => void) {
    this.log = log; this.save = save;
    this.height = height; this.element.className = 'run-log-resize'; this.element.tabIndex = 0;
    this.element.setAttribute('role', 'separator'); this.element.setAttribute('aria-orientation', 'horizontal');
    this.element.setAttribute('aria-label', 'Resize log preview'); this.element.setAttribute('aria-valuemin', '180'); this.element.setAttribute('aria-valuemax', '1200');
    this.element.title = 'Drag to resize. Use Up and Down arrow keys for smaller adjustments.';
    const label = document.createElement('span'); label.textContent = 'Resize log'; this.element.append(icon('dots-six'), label);
    this.element.addEventListener('pointerdown', event => {
      if (this.disposed || event.button !== 0 || this.drag) return;
      event.preventDefault(); this.element.focus({ preventScroll: true });
      this.drag = { y: event.clientY, height: this.log.getBoundingClientRect().height || this.height, saved: this.height, pointer: event.pointerId };
      this.element.dataset.dragging = 'true'; window.addEventListener('pointermove', this.move); window.addEventListener('pointerup', this.end); window.addEventListener('pointercancel', this.cancel);
    });
    this.element.addEventListener('keydown', event => {
      if (this.disposed || this.drag) return;
      const step = event.shiftKey ? 64 : 32;
      const displayedHeight = this.log.getBoundingClientRect().height || this.height;
      const height = event.key === 'Home' ? 180 : event.key === 'End' ? 1200 : event.key === 'ArrowDown' ? displayedHeight + step : event.key === 'ArrowUp' ? displayedHeight - step : null;
      if (height === null) return; event.preventDefault(); this.apply(height); this.save(this.height);
    });
    this.apply(height);
  }
  private apply(height: number) {
    this.height = Math.round(Math.max(180, Math.min(1200, height)));
    const follow = this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop <= 20;
    this.log.style.height = `${this.height}px`; this.element.setAttribute('aria-valuenow', String(this.height)); this.element.setAttribute('aria-valuetext', `${this.height} pixels`);
    if (follow) this.log.scrollTop = this.log.scrollHeight;
  }
  private move = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    event.preventDefault(); this.apply(this.drag.height + event.clientY - this.drag.y);
  };
  private end = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    this.move(event); this.cleanup(); this.save(this.height);
  };
  private cancel = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    this.cancelDrag();
  };
  private cleanup() {
    this.drag = null; delete this.element.dataset.dragging;
    window.removeEventListener('pointermove', this.move); window.removeEventListener('pointerup', this.end); window.removeEventListener('pointercancel', this.cancel);
  }
  cancelDrag = () => { if (this.drag) this.apply(this.drag.saved); this.cleanup(); };
  dispose = () => { this.disposed = true; this.cancelDrag(); };
}

import { afterEach, expect, it, vi } from 'vitest';
import { attachEvidenceInteractions } from './evidence-interactions';
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.body.replaceChildren(); vi.useRealTimers(); });
function fixture() {
  const root = document.createElement('div'); root.innerHTML = '<details class="pr-stat-preview"><summary>2 passed</summary><div class="pr-stat-popup"><a href="#check">Check</a><details><summary>Show more</summary><p>Other checks</p></details></div></details><button>Outside preview</button>';
  document.body.append(root); stops.push(attachEvidenceInteractions(root, new AbortController().signal));
  return { root, details: root.querySelector<HTMLDetailsElement>('.pr-stat-preview')!, summary: root.querySelector<HTMLElement>('.pr-stat-preview>summary')! };
}
function pointer(target: Element, type: string, relatedTarget?: Node, pointerType = 'mouse') {
  const event = new Event(type, { bubbles: true }); Object.defineProperties(event, { pointerType: { value: pointerType }, relatedTarget: { value: relatedTarget } }); target.dispatchEvent(event);
}
it('opens on hover and remains usable as the pointer enters the popup and its Show more disclosure', () => {
  const f = fixture(); pointer(f.summary, 'pointerover'); expect(f.details.open).toBe(true);
  const more = f.root.querySelector<HTMLElement>('.pr-stat-popup details>summary')!; pointer(f.summary, 'pointerout', more); pointer(more, 'pointerover'); more.click(); expect(f.details.open).toBe(true);
});
it('supports keyboard focus, click pinning, repeated-click dismissal and Escape with summary focus', () => {
  const f = fixture(); f.summary.focus(); expect(f.details.open).toBe(true); f.summary.click(); expect(f.details.open).toBe(true); f.summary.click(); expect(f.details.open).toBe(false);
  f.summary.click(); f.root.querySelector<HTMLElement>('a')!.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(f.details.open).toBe(false); expect(document.activeElement).toBe(f.summary);
});
it('closes after pointer leave and closes a pinned preview on outside pointer activation', () => {
  vi.useFakeTimers(); const f = fixture(); pointer(f.summary, 'pointerover'); pointer(f.summary, 'pointerout', document.body); vi.advanceTimersByTime(121); expect(f.details.open).toBe(false);
  f.summary.click(); pointer(f.root.querySelector('button')!, 'pointerdown'); expect(f.details.open).toBe(false);
});
it('supports touch activation without hover and removes global listeners on disposal', () => {
  const f = fixture(); pointer(f.summary, 'pointerover', undefined, 'touch'); expect(f.details.open).toBe(false); f.summary.click(); expect(f.details.open).toBe(true);
  stops.splice(0).forEach(stop => stop()); expect(f.details.open).toBe(false); f.details.open = true; pointer(document.body, 'pointerdown'); expect(f.details.open).toBe(true);
});

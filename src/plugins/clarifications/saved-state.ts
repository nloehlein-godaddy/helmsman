import type { PanelOpaqueStateV1, PluginPanelContext } from '@helmsman/plugin-sdk';

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d_-]{1,128}$/i.test(value);
export const repository = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(value) && !['.', '..'].includes(value.split('/')[1] ?? '');
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(value);
export const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const fields = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
export function bounded(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512 * 1024; } catch { return false; }
}
export class SavedState<T> {
  value: T;
  error = '';
  conflict = false;
  readonly unsupported: boolean;
  private baseline: PanelOpaqueStateV1 | null;
  private incoming: PanelOpaqueStateV1 | null;
  private proposal: PanelOpaqueStateV1 | null = null;
  private changed = 0;
  private saved = 0;
  private pending: Promise<boolean> | null = null;
  private readonly context: PluginPanelContext;
  private readonly parse: (value: PanelOpaqueStateV1 | null) => T | null;
  private readonly notify: () => void;
  constructor(context: PluginPanelContext, parse: (value: PanelOpaqueStateV1 | null) => T | null,
    empty: () => T, notify: () => void) {
    this.context = context; this.parse = parse; this.notify = notify;
    this.baseline = context.state.savedState; this.incoming = this.baseline;
    const parsed = parse(this.baseline); this.unsupported = parsed === null; this.value = parsed ?? empty();
    if (this.unsupported) this.error = 'Saved state is unsupported or invalid. It is preserved; writing and acknowledgment are unavailable.';
    else if (!context.compareAndSetState) this.error = 'Conditional saved-state storage is unavailable. Writing and acknowledgment are disabled.';
  }
  get writable(): boolean { return !this.unsupported && !!this.context.compareAndSetState && !this.conflict; }
  edit(change: (value: T) => void): void { change(this.value); ++this.changed; }
  receive(next: PanelOpaqueStateV1 | null): void {
    this.incoming = next;
    if (canonical(next) === canonical(this.baseline) || this.proposal && canonical(next) === canonical(this.proposal)) return;
    if (this.changed !== this.saved || this.pending) { this.conflict = true; this.error = 'Saved state changed elsewhere. Your local edits and original requests are kept.'; return; }
    const parsed = this.parse(next);
    if (parsed === null) { this.conflict = true; this.error = 'Saved state changed to an unsupported value. Your current view and requests are kept.'; return; }
    this.baseline = next; this.value = parsed;
  }
  reload(): void {
    if (this.pending || this.unsupported) return;
    const parsed = this.parse(this.incoming);
    if (parsed === null) { this.error = 'Saved state is unsupported. It is preserved.'; return; }
    this.value = parsed; this.baseline = this.incoming; this.conflict = false; this.changed = this.saved = 0; this.error = ''; this.notify();
  }
  save(): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!this.writable || this.context.signal.aborted) return Promise.resolve(false);
    this.pending = this.write().finally(() => { this.pending = null; this.notify(); }); return this.pending;
  }
  private async write(): Promise<boolean> {
    let check = true;
    while (check || this.changed !== this.saved) {
      check = false;
      if (!this.writable || this.context.signal.aborted) return false;
      const revision = this.changed; const next: PanelOpaqueStateV1 = { version: 1, value: structuredClone(this.value) };
      if (!bounded(next) || this.parse(next) === null) { this.error = 'Saved state is full or invalid. Explicitly remove an unused draft or result before saving more.'; return false; }
      this.proposal = next;
      try {
        await this.context.compareAndSetState!(this.baseline, next);
        this.baseline = next; this.saved = revision;
        if (!this.conflict) { this.incoming = next; this.error = ''; }
      } catch { this.error = this.conflict ? 'Saved state changed elsewhere. Your local edits and original requests are kept.' : 'Saved state could not be written. Your draft and original requests are retained; retry saving.'; return false; }
      finally { this.proposal = null; }
    }
    return !this.conflict;
  }
}

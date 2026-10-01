import { AttentionChime, type AttentionAudio } from '../logic/attentionChime';
import { createHostPageServices } from './host-services';
import { clarificationAbortable } from './clarification-transport';
import type { PluginPageAttentionV1, PluginPageModule, PluginPageServices } from './sdk';

interface Selection { id: string; module: PluginPageModule; repo: string | null; selected: boolean; }
interface Session extends Selection {
  lifetime: AbortController;
  services: PluginPageServices;
  generation: number;
  read: AbortController | null;
  pendingSound: Set<string>;
}
function keys(value: unknown): readonly string[] | null {
  if (value === null) return null;
  const result = value as Partial<PluginPageAttentionV1> | null;
  if (!result || result.version !== 1 || !Array.isArray(result.keys) || result.keys.length > 1000
    || result.keys.some(key => typeof key !== 'string' || !key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key))
    || new Set(result.keys).size !== result.keys.length) throw new TypeError('Invalid page attention snapshot');
  return result.keys;
}

export class PageAttentionHost {
  private session: Session | null = null;
  private disposed = false;
  private unlocking = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly seen = new Set<string>();
  private readonly changed: (attention: boolean) => void;
  private readonly audio: AttentionAudio;
  private readonly services: typeof createHostPageServices;
  constructor(changed: (attention: boolean) => void, options: { audio?: AttentionAudio; services?: typeof createHostPageServices } = {}) {
    this.changed = changed; this.audio = options.audio ?? new AttentionChime(); this.services = options.services ?? createHostPageServices;
    document.addEventListener('pointerdown', this.gesture, true); document.addEventListener('keydown', this.gesture, true);
  }
  update(selection: Selection | null): void {
    if (this.disposed) return;
    const current = this.session;
    if (selection && current && selection.id === current.id && selection.module === current.module && selection.repo === current.repo) {
      if (selection.selected !== current.selected) {
        current.selected = selection.selected;
        if (selection.selected) for (const key of current.pendingSound) this.seen.add(key);
        current.pendingSound.clear(); this.audio.stop(); this.changed(false); void this.refresh();
      }
      return;
    }
    this.clear();
    if (!selection?.module.attention) return;
    const lifetime = new AbortController();
    const session: Session = { ...selection, lifetime, generation: 0, read: null, pendingSound: new Set(),
      services: this.services(lifetime.signal, () => ({ repo: selection.repo, active: this.session === session && !this.disposed,
        epoch: 0, signal: lifetime.signal }), selection.id) };
    this.session = session; void this.refresh();
  }
  private active(session: Session, generation = session.generation): boolean {
    return !this.disposed && this.session === session && !session.lifetime.signal.aborted && generation === session.generation;
  }
  private gesture = (event: Event): void => {
    if (event.isTrusted && (!(event instanceof KeyboardEvent) || !event.repeat)) void this.unlock();
  };
  async unlock(): Promise<void> {
    const session = this.session; if (!session || this.disposed || this.audio.ready || this.unlocking) return;
    const generation = session.generation; this.unlocking = true;
    try {
      await this.audio.unlock();
      if (this.active(session, generation) && !session.selected) await this.refresh();
    } finally { this.unlocking = false; }
  }
  async refresh(): Promise<void> {
    const session = this.session; if (!session || !this.active(session)) return;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    session.read?.abort(); const generation = ++session.generation; const read = new AbortController(); session.read = read;
    const signal = AbortSignal.any([session.lifetime.signal, read.signal, AbortSignal.timeout(30_000)]);
    try {
      const value = await clarificationAbortable(Promise.resolve(session.module.attention?.({ contributionId: session.id, repo: session.repo, signal, services: session.services })), signal);
      if (!this.active(session, generation) || signal.aborted) return;
      const pending = keys(value);
      if (pending === null) { session.pendingSound.clear(); this.audio.stop(); this.changed(false); return; }
      const identities = pending.map(key => JSON.stringify([session.id, key]));
      const present = new Set(identities);
      for (const key of session.pendingSound) if (!present.has(key)) session.pendingSound.delete(key);
      for (const key of identities) {
        if (!this.seen.has(key) && !session.selected) session.pendingSound.add(key);
        if (session.selected) this.seen.add(key);
      }
      while (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
      if (session.selected) session.pendingSound.clear();
      this.changed(!session.selected && pending.length > 0);
      if (!pending.length || session.selected) this.audio.stop();
      if (session.pendingSound.size && !session.selected) {
        const batch = [...session.pendingSound];
        void this.audio.play(() => this.active(session, generation) && !session.selected
          && batch.some(key => session.pendingSound.has(key))).then(played => {
          if (played && this.active(session, generation)) for (const key of batch) { this.seen.add(key); session.pendingSound.delete(key); }
        }).catch(() => {});
      }
    } catch {
      if (this.active(session, generation)) { session.pendingSound.clear(); this.audio.stop(); this.changed(false); }
    } finally {
      if (this.active(session, generation)) { session.read = null; this.timer = setTimeout(() => { void this.refresh(); }, 5_000); }
    }
  }
  private clear(): void {
    const session = this.session; this.session = null; session?.lifetime.abort(); session?.read?.abort();
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.audio.stop(); this.changed(false);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.clear(); this.audio.dispose(); this.seen.clear();
    document.removeEventListener('pointerdown', this.gesture, true); document.removeEventListener('keydown', this.gesture, true);
  }
}

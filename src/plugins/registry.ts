import { isContributionId, isSlotId, parsePluginManifest, PluginManifestError } from './manifest';
import type { PageResolution, PageSlot, RegisteredPluginPage } from './sdk';
import { supportsPageSlot } from './frontend-manifests';

function validHostPath(path: unknown): path is string {
  return typeof path === 'string' && (path === '/' || /^\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(path))
    && path !== '/plugins' && !path.startsWith('/plugins/');
}

export class PluginPageRegistry {
  private readonly slots = new Map<string, PageSlot>();
  private readonly aliases = new Map<string, string>();
  private readonly pages = new Map<string, RegisteredPluginPage>();
  private readonly plugins = new Map<string, object>();
  private readonly bindings = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly reserved: ReadonlySet<string>;

  constructor(slots: readonly PageSlot[], reservedPaths: readonly string[] = []) {
    if (!Array.isArray(slots) || !Array.isArray(reservedPaths) || !Array.from(reservedPaths).every(validHostPath)
      || new Set(reservedPaths).size !== reservedPaths.length) {
      throw new PluginManifestError('Reserved paths and slots must be valid unique lists.');
    }
    this.reserved = new Set(reservedPaths);
    for (const slot of slots) this.registerSlot(slot);
  }

  registerSlot(slot: PageSlot): void {
      if (!slot || !isSlotId(slot.id) || !validHostPath(slot.alias) || slot.alias === '/'
        || !isContributionId(slot.defaultContributionId)) throw new PluginManifestError('Invalid page slot.');
      if (slot.aliases !== undefined && (!Array.isArray(slot.aliases) || slot.aliases.length > 16)) throw new PluginManifestError('Invalid page aliases.');
      const aliases = [slot.alias, ...(slot.aliases ?? [])];
      if (!Array.from(aliases).every(validHostPath) || new Set(aliases).size !== aliases.length) throw new PluginManifestError('Invalid page aliases.');
      if (this.slots.has(slot.id) || aliases.some(alias => this.aliases.has(alias) || this.reserved.has(alias))) {
        throw new PluginManifestError('Page slot or alias collides with an existing route.');
      }
      const copy = Object.freeze({ id: slot.id, alias: slot.alias, defaultContributionId: slot.defaultContributionId,
        ...(slot.aliases ? { aliases: Object.freeze([...slot.aliases]) } : {}) });
      this.slots.set(copy.id, copy);
      for (const alias of aliases) this.aliases.set(alias, copy.id);
      this.notify();
  }

  register(value: unknown): () => void {
    const manifest = parsePluginManifest(value);
    if (this.plugins.has(manifest.id)) throw new PluginManifestError(`Plugin ${manifest.id} is already registered.`);
    const pages = manifest.pages.map(page => Object.freeze({
      ...page,
      pluginId: manifest.id,
      contributionId: `${manifest.id}/${page.id}`,
      canonicalPath: `/plugins/${manifest.id}/${page.id}`,
    }));
    const registration = {};
    this.plugins.set(manifest.id, registration);
    for (const page of pages) this.pages.set(page.contributionId, page);
    this.notify();
    return () => {
      if (this.plugins.get(manifest.id) !== registration) return;
      this.plugins.delete(manifest.id);
      for (const page of pages) this.pages.delete(page.contributionId);
      this.notify();
    };
  }

  listPages(): readonly RegisteredPluginPage[] {
    return Object.freeze([...this.pages.values()].sort((a, b) => a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0));
  }

  getPage(contributionId: string): RegisteredPluginPage | null {
    return this.pages.get(contributionId) ?? null;
  }

  unregister(pluginId: string): void {
    if (!this.plugins.delete(pluginId)) return;
    for (const [id, page] of this.pages) if (page.pluginId === pluginId) this.pages.delete(id);
    this.notify();
  }

  getSlot(slotId: string): PageSlot | null {
    return this.slots.get(slotId) ?? null;
  }

  resolvePath(path: string): PageResolution | null {
    const slotId = this.aliases.get(path);
    if (slotId) return this.selected(slotId);
    if (typeof path !== 'string' || !path.startsWith('/plugins/')) return null;
    const contributionId = path.slice('/plugins/'.length);
    return isContributionId(contributionId)
      ? Object.freeze({ contributionId, slotId: null, page: this.getPage(contributionId) }) : null;
  }

  selected(slotId: string): PageResolution {
    const slot = this.slots.get(slotId);
    if (!slot) throw new PluginManifestError(`Unknown page slot: ${slotId}.`);
    const contributionId = this.bindings.get(slotId) ?? slot.defaultContributionId;
    const page = this.getPage(contributionId);
    return Object.freeze({ contributionId, slotId, page: page && supportsPageSlot(page, slotId) ? page : null });
  }

  select(slotId: string, contributionId: string | null): void {
    this.setSelection(slotId, contributionId, false);
  }

  restoreSelection(slotId: string, contributionId: string | null): void {
    this.setSelection(slotId, contributionId, true);
  }

  private setSelection(slotId: string, contributionId: string | null, retained: boolean): void {
    if (!this.slots.has(slotId)) throw new PluginManifestError(`Unknown page slot: ${slotId}.`);
    if (contributionId !== null) {
      if (!isContributionId(contributionId)) throw new PluginManifestError('Invalid contribution ID.');
      const page = this.getPage(contributionId);
      if (!retained && page && !supportsPageSlot(page, slotId)) throw new PluginManifestError('Page does not support the selected slot.');
    }
    if (contributionId === null) {
      if (!this.bindings.delete(slotId)) return;
    } else {
      if (this.bindings.get(slotId) === contributionId) return;
      this.bindings.set(slotId, contributionId);
    }
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new PluginManifestError('Registry listener must be a function.');
    const subscription = () => listener();
    this.listeners.add(subscription);
    return () => { this.listeners.delete(subscription); };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { continue; }
    }
  }
}

import { isContributionId, isSlotId, parsePluginManifest, PluginManifestError } from './manifest';
import type { PageResolution, PageSlot, RegisteredPluginPage } from './sdk';

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

  constructor(slots: readonly PageSlot[], reservedPaths: readonly string[] = []) {
    if (!Array.isArray(slots) || !Array.isArray(reservedPaths) || !Array.from(reservedPaths).every(validHostPath)
      || new Set(reservedPaths).size !== reservedPaths.length) {
      throw new PluginManifestError('Reserved paths and slots must be valid unique lists.');
    }
    const reserved = new Set(reservedPaths);
    for (const slot of slots) {
      if (!slot || !isSlotId(slot.id) || !validHostPath(slot.alias) || slot.alias === '/'
        || !isContributionId(slot.defaultContributionId)) throw new PluginManifestError('Invalid page slot.');
      if (this.slots.has(slot.id) || this.aliases.has(slot.alias) || reserved.has(slot.alias)) {
        throw new PluginManifestError('Page slot or alias collides with an existing route.');
      }
      const copy = Object.freeze({ id: slot.id, alias: slot.alias, defaultContributionId: slot.defaultContributionId });
      this.slots.set(copy.id, copy);
      this.aliases.set(copy.alias, copy.id);
    }
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

  getPage(contributionId: string): RegisteredPluginPage | null {
    return this.pages.get(contributionId) ?? null;
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
    return Object.freeze({ contributionId, slotId, page: page?.slots.includes(slotId) ? page : null });
  }

  select(slotId: string, contributionId: string | null): void {
    if (!this.slots.has(slotId)) throw new PluginManifestError(`Unknown page slot: ${slotId}.`);
    if (contributionId !== null) {
      if (!isContributionId(contributionId)) throw new PluginManifestError('Invalid contribution ID.');
      const page = this.getPage(contributionId);
      if (page && !page.slots.includes(slotId)) throw new PluginManifestError('Page does not support the selected slot.');
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

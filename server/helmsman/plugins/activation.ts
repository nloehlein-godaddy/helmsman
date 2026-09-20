import type { PluginSnapshot } from './store';

export function retainActivatedPluginPages(snapshot: PluginSnapshot, backendIds: readonly string[]): PluginSnapshot {
  const active = new Set(backendIds);
  const failed = snapshot.catalog.plugins.filter(plugin => plugin.package.backend && !active.has(plugin.package.manifest.id));
  const failedIds = new Set(failed.map(plugin => plugin.package.manifest.id));
  return {
    catalog: { ...snapshot.catalog, plugins: snapshot.catalog.plugins.filter(plugin => !failedIds.has(plugin.package.manifest.id)) },
    artifacts: new Map([...snapshot.artifacts].filter(([, archive]) => !failedIds.has(archive.package.manifest.id))),
    errors: [...snapshot.errors, ...failed.map(plugin => `Plugin ${plugin.package.manifest.id} backend failed; its pages remain unavailable.`)],
  };
}

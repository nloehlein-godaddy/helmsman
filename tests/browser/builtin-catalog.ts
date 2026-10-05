import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';

export function builtinCatalog(ids: readonly string[], enabled?: ReadonlySet<string>) {
  return ids.map(id => {
    const manifest = builtinFrontendManifests.find(item => item.id === id);
    if (!manifest) throw new Error(`Unknown built-in fixture: ${id}`);
    return { id, version: manifest.version, hash: 'a'.repeat(64), enabled: enabled?.has(id) ?? true };
  });
}

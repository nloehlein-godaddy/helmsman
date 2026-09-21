import { builtinFrontendManifests } from '../../../src/plugins/frontend-manifests';
import { parsePluginPackage } from '../../../src/plugins/package';

export const builtinFrontendPackages = Object.freeze(builtinFrontendManifests.map(manifest => parsePluginPackage({
  packageVersion: 1,
  manifest,
  node: { minMajor: 22, maxMajorExclusive: 30 },
  entries: Object.fromEntries(manifest.pages.map(page => [page.id, `bundled/${page.id}.js`])),
  ...(manifest.manifestVersion === 2 ? { panelEntries: Object.fromEntries(manifest.panels.map(panel => [panel.id, `bundled/${panel.id}.js`])) } : {}),
}, { allowBuiltin: true })));

export function builtinFrontendArtifacts(artifactHash: string) {
  if (!/^[a-f\d]{64}$/.test(artifactHash)) throw new Error('Invalid built-in frontend artifact hash');
  return builtinFrontendPackages.map(pkg => ({ package: pkg, artifactHash }));
}

import type { PluginPackage } from '../../../src/plugins/package';

export function assertPluginNodeCompatibility(pkg: PluginPackage, nodeMajor = Number(process.versions.node.split('.')[0])): void {
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < pkg.node.minMajor || nodeMajor >= pkg.node.maxMajorExclusive) {
    throw new Error(`Plugin ${pkg.manifest.id} does not support Node ${nodeMajor}.`);
  }
}

import { parsePluginPackage } from '../../../src/plugins/package';
import standardPricing from '../../../src/plugins/pricing/standard';

export const builtinPricing = {
  package: parsePluginPackage({
    packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'helmsman.standard-pricing', version: '0.1.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 22, maxMajorExclusive: 30 },
    entries: {},
    backend: { entry: 'standard.js', provides: [{ id: 'helmsman/pricing', version: 1, localId: 'standard' }], settings: {}, storageVersion: 1 },
  }, { allowBuiltin: true }),
  module: standardPricing,
};

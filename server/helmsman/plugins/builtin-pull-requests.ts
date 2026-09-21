import { parsePluginPackage } from '../../../src/plugins/package';
import github from '../../../src/plugins/github/backend';
import type { BuiltinBackendPlugin } from './backend';

export const builtinPullRequests: readonly BuiltinBackendPlugin[] = [
  { package: parsePluginPackage({ packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'helmsman.github', version: '0.1.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/pull-request', version: 1, localId: 'github' }],
      pullRequests: { github: { access: ['core-http'] } }, settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: github },
];

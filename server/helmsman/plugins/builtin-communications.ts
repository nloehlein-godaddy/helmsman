import { parsePluginPackage } from '../../../src/plugins/package';
import slack from '../../../src/plugins/slack/backend';
import slackCompanion from '../../../src/plugins/slack-companion/backend';
import type { BuiltinBackendPlugin } from './backend';

export const builtinCommunications: readonly BuiltinBackendPlugin[] = [
  { package: parsePluginPackage({ packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'helmsman.slack-companion', version: '0.1.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/communication', version: 1, localId: 'slack' }],
      communications: { slack: { access: ['provider-network'] } }, settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: slackCompanion },
  { package: parsePluginPackage({ packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'helmsman.slack', version: '0.1.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/communication', version: 1, localId: 'slack' }],
      communications: { slack: { access: ['browser-session'] } }, settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: slack },
];

import { parsePluginPackage } from '../../../src/plugins/package';
import github from '../../../src/plugins/feedback-github/backend';
import type { BuiltinBackendPlugin } from './backend';
export const builtinFeedbackTrackers: readonly BuiltinBackendPlugin[] = [{ package: parsePluginPackage({ packageVersion: 1,
  manifest: { manifestVersion: 1, id: 'helmsman.feedback-github', version: '0.1.0', sdkVersion: 1, pages: [] },
  node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
  backend: { entry: 'backend.js', provides: [{ id: 'helmsman/feedback-tracker', version: 1, localId: 'issues' }],
    feedbackTrackers: { issues: { access: ['connection-http'] } },
    settings: { enabled: { type: 'boolean', default: false }, repository: { type: 'string', default: '', maxLength: 256 }, labels: { type: 'string', default: '', maxLength: 512 } }, storageVersion: 1 } }, { allowBuiltin: true }), module: github }];

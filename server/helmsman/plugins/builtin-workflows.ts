import { parsePluginPackage } from '../../../src/plugins/package';
import coding from '../../../src/plugins/workflow-coding/backend';
import review from '../../../src/plugins/workflow-review/backend';
import type { BuiltinBackendPlugin } from './backend';

export const builtinWorkflows: readonly BuiltinBackendPlugin[] = [
  {
    package: parsePluginPackage({
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'helmsman.workflow-coding', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 },
      entries: {},
      backend: {
        entry: 'backend.js',
        provides: [
          { id: 'helmsman/workflow', version: 1, localId: 'coding' },
          { id: 'helmsman/workflow', version: 1, localId: 'branch' },
        ],
        workflows: {
          coding: { access: ['workflow-policy'] },
          branch: { access: ['workflow-policy'] },
        },
        settings: {
          maxRounds: { type: 'number', default: 3, minimum: 1, maximum: 5 },
          stageTimeoutMinutes: { type: 'number', default: 45, minimum: 5, maximum: 180 },
        },
        storageVersion: 1,
      },
    }, { allowBuiltin: true }),
    module: coding,
  },
  {
    package: parsePluginPackage({
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'helmsman.workflow-review', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 },
      entries: {},
      backend: {
        entry: 'backend.js',
        provides: [{ id: 'helmsman/workflow', version: 1, localId: 'review' }],
        workflows: { review: { access: ['workflow-policy'] } },
        settings: {},
        storageVersion: 1,
      },
    }, { allowBuiltin: true }),
    module: review,
  },
];

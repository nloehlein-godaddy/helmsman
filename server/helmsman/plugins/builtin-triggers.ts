import { parsePluginPackage } from '../../../src/plugins/package';
import campaign from '../../../src/plugins/trigger-campaign/backend';
import githubReview from '../../../src/plugins/trigger-github-review/backend';
import githubWebhook from '../../../src/plugins/trigger-github-webhook/backend';
import slackReview from '../../../src/plugins/trigger-slack-review/backend';
import type { BuiltinBackendPlugin } from './backend';

export const builtinTriggers: readonly BuiltinBackendPlugin[] = [
  {
    package: parsePluginPackage({
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'helmsman.trigger-campaign', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: {
        entry: 'backend.js',
        provides: [{ id: 'helmsman/trigger', version: 1, localId: 'dispatch' }],
        triggers: { dispatch: { access: ['campaign-candidates'] } },
        settings: {
          enabled: { type: 'boolean', default: true },
          intervalMs: { type: 'number', default: 5_000, minimum: 1_000, maximum: 3_600_000 },
        },
        storageVersion: 1,
      },
    }, { allowBuiltin: true }),
    module: campaign,
  },
  {
    package: parsePluginPackage({
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'helmsman.trigger-slack-review', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: {
        entry: 'backend.js',
        provides: [{ id: 'helmsman/trigger', version: 1, localId: 'watch' }],
        triggers: { watch: { access: ['review-discovery'] } },
        settings: {
          enabled: { type: 'boolean', default: true },
          intervalMs: { type: 'number', default: 300_000, minimum: 1_000, maximum: 3_600_000 },
          overlapSeconds: { type: 'number', default: 300, minimum: 0, maximum: 3_600 },
          repoFilterJson: { type: 'string', default: '[]', maxLength: 4_096 },
        },
        storageVersion: 1,
      },
    }, { allowBuiltin: true }),
    module: slackReview,
  },
  {
    package: parsePluginPackage({
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'helmsman.trigger-github-review', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: {
        entry: 'backend.js',
        provides: [{ id: 'helmsman/trigger', version: 1, localId: 'watch' }],
        triggers: { watch: { access: ['review-discovery'] } },
        settings: {
          enabled: { type: 'boolean', default: true },
          intervalMs: { type: 'number', default: 300_000, minimum: 1_000, maximum: 3_600_000 },
        },
        storageVersion: 1,
      },
    }, { allowBuiltin: true }),
    module: githubReview,
  },
  {
    package: parsePluginPackage({
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'helmsman.trigger-github-webhook', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: {
        entry: 'backend.js',
        provides: [{ id: 'helmsman/trigger', version: 1, localId: 'github' }],
        triggers: { github: { access: ['authenticated-event'] } },
        settings: {
          enabled: { type: 'boolean', default: false },
          routesJson: { type: 'string', default: '[]', maxLength: 4_096 },
        },
        storageVersion: 1,
      },
    }, { allowBuiltin: true }),
    module: githubWebhook,
  },
];

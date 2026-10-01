// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainLegacyRuntime } from './legacy-runtime-artifact';
import { installPluginArtifact } from './plugins/artifacts';
import { loadRetainedFeedbackTrackerProvider } from './feedback-tracker-retained-loader';
import type { FeedbackTrackerRetainedProviderV1 } from './feedback-tracker-providers';
import { createFeedbackTrackerProviderRegistry, resolveSelectedFeedbackTrackerProvider } from './feedback-tracker-providers';
import { readFeedbackTrackerProviderBinding, selectFeedbackTrackerProvider } from './plugins/data';
import { pluginCommand } from './plugins/cli';
const roots: string[] = []; afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-feedback-')); roots.push(root); return root; }
function descriptor(id = 'example.feedback') { return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, backend: { entry: 'backend.js', provides: [{ id: 'helmsman/feedback-tracker', version: 1, localId: 'issues' }], feedbackTrackers: { issues: { access: ['connection-http'] } }, settings: { repository: { type: 'string', default: '', maxLength: 256 } }, storageVersion: 1 } }; }
const source = `export default { activate(context) {
 if (Object.keys(context).sort().join(',') !== 'onDispose,pluginId,registerFeedbackTracker,settings,signal') throw new Error('Unexpected feedback services');
 context.registerFeedbackTracker('issues', { async destination() { return {id:context.settings.repository,label:context.settings.repository,url:'https://example.test/issues'}; }, async prepareSubmission() { throw new Error('not used'); }, async invokeSubmission() { throw new Error('not used'); }, async reconcileSubmission() { return {status:'unknown',reason:'pending',evidence:{}}; } });
} };`;
it('loads the exact external package and original settings independently of current selection', async () => {
  const root = await temporary(); const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor(), files: [{ path: 'backend.js', base64: Buffer.from(source).toString('base64') }] })));
  const record: FeedbackTrackerRetainedProviderV1 = { origin: 'plugin', settings: { repository: 'old/destination' }, binding: { providerId: 'example.feedback/issues', pluginId: 'example.feedback', artifactHash: archive.hash, contractVersion: 1, connectionId: null, credentialHandle: null } };
  const artifacts = [{ pluginId: record.binding.pluginId, artifactHash: archive.hash, packageVersion: '1.0.0', requires: [] }];
  selectFeedbackTrackerProvider(root, 'example.other/issues');
  const input = { pluginsRoot: root, runtimeArtifactsRoot: root, record, artifacts };
  const loaded = await loadRetainedFeedbackTrackerProvider(input);
  expect(await loaded.provider.destination({ signal: new AbortController().signal, http: { request: async () => { throw new Error('unused'); } } })).toMatchObject({ id: 'old/destination' }); await loaded.dispose();
  await expect(loadRetainedFeedbackTrackerProvider({ ...input, record: { ...record, settings: { repository: 'old/destination', extra: true } } })).rejects.toThrow('settings');
  await expect(loadRetainedFeedbackTrackerProvider({ ...input, artifacts: [{ ...artifacts[0]!, requires: ['example.missing'] }] })).rejects.toThrow('dependency');
});
it('loads builtin trackers from archived runtime after original source is removed and rejects altered bytes', async () => {
  const root = await temporary(); const original = join(root, 'original'); const runtimeArtifactsRoot = join(root, 'retained'); await mkdir(join(original, 'server', 'helmsman', 'plugins'), { recursive: true });
  await writeFile(join(original, 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', type: 'module' })); await writeFile(join(original, 'server', 'helmsman', 'main.js'), 'export {};');
  const catalog = `const plugin = ${source.replace('export default ', '').replace(/;$/, '')}; export const builtinFeedbackTrackers = [{ package: ${JSON.stringify(descriptor('helmsman.original-feedback'))}, module: plugin }];`;
  await writeFile(join(original, 'server', 'helmsman', 'plugins', 'builtin-feedback-trackers.js'), catalog); const runtime = await retainLegacyRuntime(original, runtimeArtifactsRoot); await rm(original, { recursive: true });
  const record: FeedbackTrackerRetainedProviderV1 = { origin: 'builtin', settings: { repository: 'saved/destination' }, binding: { providerId: 'helmsman.original-feedback/issues', pluginId: 'helmsman.original-feedback', artifactHash: runtime.artifact.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null } };
  const artifacts = [runtime.artifact, { pluginId: record.binding.pluginId, artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [runtime.artifact.pluginId] }];
  const input = { pluginsRoot: root, runtimeArtifactsRoot, record, artifacts }; const loaded = await loadRetainedFeedbackTrackerProvider(input);
  expect(await loaded.provider.destination({ signal: new AbortController().signal, http: { request: async () => { throw new Error('unused'); } } })).toMatchObject({ id: 'saved/destination' }); await loaded.dispose();
  await writeFile(join(runtime.root, 'server', 'helmsman', 'plugins', 'builtin-feedback-trackers.js'), `${catalog}\n `); await expect(loadRetainedFeedbackTrackerProvider(input)).rejects.toThrow('unavailable');
});
it('keeps feedback unselected until explicit selection and persists disabled across reads', async () => {
  const root = await temporary(); const registry = createFeedbackTrackerProviderRegistry({ eligible: () => true }); const options = { root, registry, connection: () => ({ connectionId: 'github', credentialHandle: 'github' }) };
  expect(resolveSelectedFeedbackTrackerProvider(options)).toBeNull();
  await pluginCommand(['--dir', root, 'select-feedback', 'example.feedback/issues'], { coordinate: false }); expect(readFeedbackTrackerProviderBinding(root)).toBe('example.feedback/issues');
  await pluginCommand(['--dir', root, 'select-feedback', 'disabled'], { coordinate: false }); expect(resolveSelectedFeedbackTrackerProvider(options)).toBeNull(); expect(readFeedbackTrackerProviderBinding(root)).toBeUndefined();
});

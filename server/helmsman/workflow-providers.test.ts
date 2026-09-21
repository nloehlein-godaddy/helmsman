// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflowMetadataV1, parseWorkflowPromptInputV1, parseWorkflowStepInputV1, type WorkflowMetadataV1, type WorkflowPromptInputV1, type WorkflowProviderV1, type WorkflowStepInputV1 } from '../../src/plugins/workflow';
import { parsePluginPackage } from '../../src/plugins/package';
import { boundedWorkflowProvider, createWorkflowProviderRegistry, parseWorkflowRetainedProviderV1 } from './workflow-providers';
import { loadRetainedWorkflowProvider } from './workflow-retained-loader';
import { assertWorkflowSelectionCurrent, canonicalWorkflowProviderId, DEFAULT_WORKFLOW_PROVIDERS, resolveWorkflowSelection } from './workflow-selection';
import { retainLegacyRuntime } from './legacy-runtime-artifact';
import { installPluginArtifact } from './plugins/artifacts';
import { activateBackendPlugins, type BackendRuntime } from './plugins/backend';
import { initializeWorkflowReviewerSelection, readAgentProviderSelection, selectAgentProvider, selectAgentReviewers, clearPluginSettings, workflowProviderSelectionInitialized, initializeWorkflowProviderSelection, initializeWorkflowSettings, readWorkflowProviderSelection, readPluginSettings, selectWorkflowProvider, writePluginSettings } from './plugins/data';
import { pluginCommand } from './plugins/cli';

const metadata: WorkflowMetadataV1 = { version: 1, label: 'Example workflow', modes: ['coding'], execution: 'staged', requiredSkills: [], maxRounds: 3, stageTimeoutMinutes: 45 };
const promptInput: WorkflowPromptInputV1 = { version: 1, runtime: { providerId: 'example.agent/writer', model: null, effort: null, reviewDelegation: 'none' }, byline: '_Helmsman_', clarificationInstructions: '', task: { ticketId: 'freeform', title: 'Example', repo: 'owner/repo', jiraBaseUrl: '', task: 'Implement\nthis task' }, stage: null };
const step: WorkflowStepInputV1 = { version: 1, writerId: 'example.agent/writer', reviewerIds: ['example.agent/reviewer'], round: 0, maxRounds: 3, implemented: false, revision: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), branch: 'feature' }, reviews: [] };
const provider: WorkflowProviderV1 = { metadata, renderPrompt: () => 'Original prompt', next: () => ({ kind: 'author', stage: 'implement' }) };
function descriptor(id = 'example.workflow') {
  return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 },
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/workflow', version: 1, localId: 'policy' }], workflows: { policy: { access: ['workflow-policy'] } }, storageVersion: 1,
      settings: { prompt: { type: 'string', default: 'original', maxLength: 4096 } } } };
}
const roots: string[] = []; const runtimes: BackendRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(runtimes.splice(0).map(value => value.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-workflows-')); roots.push(root); return root; }
const source = `export default { activate(context) {
 if (Object.keys(context).sort().join(',') !== 'onDispose,pluginId,registerWorkflow,settings,signal') throw new Error('Unexpected workflow services');
 context.registerWorkflow('policy', { metadata: ${JSON.stringify(metadata)}, renderPrompt() { return context.settings.prompt; }, next() { return {kind:'author',stage:'implement'}; } });
} };`;
async function fixture(body = source, pkg = descriptor()) {
  const root = await temporary();
  const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: pkg, files: [{ path: 'backend.js', base64: Buffer.from(body).toString('base64') }] })));
  const record = parseWorkflowRetainedProviderV1({ version: 1, binding: { providerId: 'example.workflow/policy', pluginId: 'example.workflow', artifactHash: archive.hash, contractVersion: 1 }, origin: 'external', settings: { prompt: 'retained' }, metadata });
  const artifacts = [{ pluginId: 'example.workflow', artifactHash: archive.hash, packageVersion: '1.0.0', requires: [] }];
  return { root, archive, record, artifacts, load: () => loadRetainedWorkflowProvider({ pluginsRoot: root, runtimeArtifactsRoot: join(root, 'legacy'), record, artifacts }) };
}
it('checks the entire retained closure before evaluating the selected compatible provider', async () => {
  const marker = '__retainedClosureworkflow';
  const major = Number(process.versions.node.split('.')[0]);
  try {
    const f = await fixture(`globalThis.${marker} = true; export default { activate() {} };`);
    const dependency = await installPluginArtifact(f.root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
      package: { ...f.archive.package, manifest: { ...f.archive.package.manifest, id: 'example.incompatible' }, node: { minMajor: major + 1, maxMajorExclusive: major + 2 } },
      files: [...f.archive.files].map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString('base64') })),
    })));
    const artifacts = [{ ...f.artifacts[0]!, requires: ['example.incompatible'] },
      { pluginId: 'example.incompatible', artifactHash: dependency.hash, packageVersion: '1.0.0', requires: [] }];
    await expect(loadRetainedWorkflowProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts })).rejects.toThrow('does not support Node');
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  } finally { Reflect.deleteProperty(globalThis, marker); }
});
it('blocks retained external code outside its Node range before top-level evaluation', async () => {
  const marker = '__retainedCompatibilityworkflow';
  const major = Number(process.versions.node.split('.')[0]);
  try {
    for (const node of [{ minMajor: major - 1, maxMajorExclusive: major }, { minMajor: major + 1, maxMajorExclusive: major + 2 }]) {
      const f = await fixture(`globalThis.${marker} = true;\n${source}`, { ...descriptor(), node });
      await expect(f.load()).rejects.toThrow('does not support Node');
      expect(Reflect.get(globalThis, marker)).toBeUndefined();
    }
  } finally { Reflect.deleteProperty(globalThis, marker); }
});
it('validates mode/executor agreement, settings bounds and workflow-only declarations', () => {
  const pkg = descriptor();
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, provides: [...pkg.backend.provides, { id: 'helmsman/pricing', version: 1, localId: 'price' }] } })).toThrow('workflow-only');
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, workflows: { policy: { access: ['storage'] } } } })).toThrow();
  for (const value of [{ ...metadata, modes: ['coding', 'branch'] }, { ...metadata, modes: ['review'] }, { ...metadata, execution: 'direct' }, { ...metadata, modes: ['coding', 'coding'] }, { ...metadata, maxRounds: 6 }, { ...metadata, stageTimeoutMinutes: 4 }, { ...metadata, requiredSkills: ['../../escape'] }, { ...metadata, requiredSkills: ['review-agent', 'review-agent'] }]) expect(() => parseWorkflowMetadataV1(value)).toThrow();
  expect(parseWorkflowMetadataV1({ ...metadata, modes: ['review', 'branch'], execution: 'direct' }).modes).toEqual(['review', 'branch']);
});
it('validates every prompt projection field before calling authored code', () => {
  const renderPrompt = vi.fn(provider.renderPrompt); const bounded = boundedWorkflowProvider({ ...provider, renderPrompt });
  const stage = { stage: 'review', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/tmp/report', round: 1, summaryCorrection: { reportPath: '/tmp/original', actualLength: 2001 } };
  expect(parseWorkflowPromptInputV1({ ...promptInput, stage }).stage).toEqual(stage);
  const invalid = [null, { ...promptInput, credentials: 'secret' }, { ...promptInput, runtime: { ...promptInput.runtime, providerId: 'invalid' } }, { ...promptInput, runtime: { ...promptInput.runtime, token: 'secret' } }, { ...promptInput, task: { ...promptInput.task, hostRuntime: {} } }, { ...promptInput, task: { ...promptInput.task, prNumber: 0 } }, { ...promptInput, task: { ...promptInput.task, skillsPath: '../escape' } }, { ...promptInput, task: { ...promptInput.task, reviewOutputPaths: { markdown: '/tmp/m', comments: '/tmp/c', token: 'secret' } } }, { ...promptInput, task: { ...promptInput.task, jiraBaseUrl: 'https://user:secret@example.com' } }, { ...promptInput, task: { ...promptInput.task, task: undefined } }, { ...promptInput, stage: { ...stage, summaryCorrection: { ...stage.summaryCorrection, reportPath: stage.reportPath } } }, { ...promptInput, stage: { ...stage, headSha: 'wrong' } }, { ...promptInput, stage: { ...stage, reportPath: '/tmp/../report' } }];
  for (const value of invalid) expect(() => bounded.renderPrompt(value as never)).toThrow();
  expect(renderPrompt).not.toHaveBeenCalled();
  expect(() => boundedWorkflowProvider({ ...provider, renderPrompt: () => 'x'.repeat(256 * 1024 + 1) }).renderPrompt(promptInput)).toThrow();
  expect(() => boundedWorkflowProvider({ ...provider, renderPrompt: () => Promise.resolve('async') as never }).renderPrompt(promptInput)).toThrow();
});
it('passes deep-frozen copies and rejects invalid policy state or actions', () => {
  let supplied: WorkflowStepInputV1 | undefined; let suppliedPrompt: WorkflowPromptInputV1 | undefined;
  const next = vi.fn((input: WorkflowStepInputV1) => { supplied = input; return { kind: 'author' as const, stage: 'implement' as const }; });
  const bounded = boundedWorkflowProvider({ ...provider, next, renderPrompt(input) { suppliedPrompt = input; return 'Prompt'; } });
  expect(bounded.next(step)).toEqual({ kind: 'author', stage: 'implement' }); bounded.renderPrompt(promptInput);
  expect(supplied).not.toBe(step); expect(Object.isFrozen(supplied?.revision)).toBe(true); expect(Object.isFrozen(supplied?.reviewerIds)).toBe(true); expect(Object.isFrozen(suppliedPrompt?.task)).toBe(true);
  next.mockClear();
  const report = { baseSha: step.revision.baseSha, headSha: step.revision.headSha, verdict: 'APPROVE', summary: 'Looks good', findings: [] };
  const reviewed = { ...step, round: 1, implemented: true, reviews: [{ reviewer: step.reviewerIds[0], report }] };
  expect(parseWorkflowStepInputV1(reviewed).reviews).toHaveLength(1);
  expect(parseWorkflowStepInputV1({ ...reviewed, reviews: [{ reviewer: step.reviewerIds[0], report: { ...report, verdict: 'REQUEST_CHANGES', summary: '界'.repeat(2000), findings: [{ title: '界'.repeat(180), body: '界'.repeat(4000) }] } }] }).reviews).toHaveLength(1);
  for (const value of [{ ...step, round: 1 }, { ...step, reviewerIds: [step.writerId, step.writerId] }, { ...step, revision: { ...step.revision, credentials: 'secret' } }, { ...reviewed, reviews: [...reviewed.reviews, ...reviewed.reviews] }, { ...reviewed, reviews: [{ reviewer: 'example.other/reviewer', report }] }, { ...reviewed, reviews: [{ reviewer: step.reviewerIds[0], report: { ...report, headSha: 'c'.repeat(40) } }] }, { ...reviewed, reviews: [{ reviewer: step.reviewerIds[0], report: { ...report, findings: [{ title: 'Problem', body: 'Details' }] } }] }, { ...reviewed, reviews: [{ reviewer: step.reviewerIds[0], report: { ...report, verdict: 'REQUEST_CHANGES', findings: [{ title: 'Problem', body: 'Details', path: '../outside', line: 1 }] } }] }]) expect(() => bounded.next(value as never)).toThrow();
  expect(next).not.toHaveBeenCalled();
  for (const action of [undefined, { kind: 'launch' }, { kind: 'publish', force: true }, { kind: 'review', reviewerId: null }, { kind: 'author', stage: 'review' }, { kind: 'stop', reason: '' }]) expect(() => boundedWorkflowProvider({ ...provider, next: () => action as never }).next(step)).toThrow();
});
it('fences synchronous invocation before and after activation cancellation', () => {
  const controller = new AbortController(); const next = vi.fn(() => { controller.abort(); return { kind: 'publish' as const }; });
  const bounded = boundedWorkflowProvider({ ...provider, next }, controller.signal);
  expect(() => bounded.next(step)).toThrow(); expect(() => bounded.next(step)).toThrow(); expect(() => bounded.renderPrompt(promptInput)).toThrow(); expect(next).toHaveBeenCalledOnce();
});
it('gives ordinary and retained providers restricted services and original captured settings', async () => {
  const f = await fixture(); writePluginSettings(f.root, f.archive.package, { prompt: 'current' });
  const runtime = await activateBackendPlugins({ root: f.root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, errors: [], artifacts: new Map([['example.workflow', f.archive]]) }, usage: { async query() { throw new Error('Unavailable'); } } }); runtimes.push(runtime);
  expect(runtime.errors).toEqual([]); expect(runtime.workflows.list()[0]?.provider.renderPrompt(promptInput)).toBe('current');
  const retained = await f.load(); expect(retained.provider.renderPrompt(promptInput)).toBe('retained'); expect(retained.provider.next(step)).toEqual({ kind: 'author', stage: 'implement' });
  await retained.dispose(); await retained.dispose(); expect(() => retained.provider.renderPrompt(promptInput)).toThrow(); expect(() => retained.provider.next(step)).toThrow();
  writePluginSettings(f.root, f.archive.package, { prompt: 'changed' }); expect(runtime.workflows.list()).toEqual([]); expect(runtime.workflows.list('obligation')).toHaveLength(1);
});
it('blocks corrupted, incomplete and mismatched retained artifacts', async () => {
  const f = await fixture();
  await expect(loadRetainedWorkflowProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts: [{ ...f.artifacts[0]!, requires: ['example.missing'] }] })).rejects.toThrow('dependency is missing');
  for (const record of [{ ...f.record, metadata: { ...metadata, maxRounds: 2 } }, { ...f.record, settings: { prompt: 'retained', extra: 'undeclared' } }]) await expect(loadRetainedWorkflowProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record, artifacts: f.artifacts })).rejects.toThrow();
  const path = join(f.root, 'artifacts', `${f.archive.hash}.json`); await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')])); await expect(f.load()).rejects.toThrow(); await rm(path); await expect(f.load()).rejects.toThrow();
});
it('resolves versioned explicit references and fences independent mode revisions without fallback', async () => {
  const root = await temporary(); let available = true;
  const registry = createWorkflowProviderRegistry({ eligible: (_binding, purpose) => available || purpose === 'obligation' });
  const registration = registry.stage({ binding: { providerId: 'example.workflow/policy', pluginId: 'example.workflow', artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider, package: parsePluginPackage(descriptor()), settings: { prompt: 'saved' }, origin: 'external' }); registry.publish([registration]);
  const options = { root, registry, mode: 'coding' as const, providerId: 'example.workflow/policy@1' }; const initial = resolveWorkflowSelection(options);
  expect(initial.record).toBe(registration.record); selectWorkflowProvider(root, 'review', 'example.review/policy'); expect(() => assertWorkflowSelectionCurrent(options, initial)).not.toThrow();
  selectWorkflowProvider(root, 'coding', 'example.workflow/policy'); expect(() => assertWorkflowSelectionCurrent(options, initial)).toThrow('selection changed');
  const selected = resolveWorkflowSelection(options); available = false; expect(() => assertWorkflowSelectionCurrent(options, selected)).toThrow();
  expect(registry.resolve(registration.record.binding, 'obligation')).toBe(registration); expect(() => registry.resolve({ ...registration.record.binding, artifactHash: 'b'.repeat(64) }, 'obligation')).toThrow();
  available = true; expect(() => resolveWorkflowSelection({ ...options, mode: 'review' })).toThrow('does not support');
  selectWorkflowProvider(root, 'coding', 'example.missing/policy'); expect(() => resolveWorkflowSelection({ root, registry, mode: 'coding' })).toThrow('unavailable');
  expect(canonicalWorkflowProviderId('coding@1')).toBe(DEFAULT_WORKFLOW_PROVIDERS.coding); expect(canonicalWorkflowProviderId('review@1')).toBe(DEFAULT_WORKFLOW_PROVIDERS.review);
  expect(() => canonicalWorkflowProviderId('example.workflow/policy@2')).toThrow(); expect(() => canonicalWorkflowProviderId('coding@2')).toThrow();
});
it('persists CLI mode choices and resets and imports legacy settings only once', async () => {
  const root = await temporary(); const pkg = parsePluginPackage(descriptor()); expect(workflowProviderSelectionInitialized(root, 'coding')).toBe(false);
  expect(() => initializeWorkflowProviderSelection(root, 'coding', 'invalid')).toThrow(); expect(workflowProviderSelectionInitialized(root, 'coding')).toBe(false);
  await pluginCommand(['--dir', root, 'select-workflow', 'coding', 'example.explicit/policy@1'], { coordinate: false });
  await pluginCommand(['--dir', root, 'select-workflow', 'review', 'review@1'], { coordinate: false });
  expect(workflowProviderSelectionInitialized(root, 'coding')).toBe(true); initializeWorkflowProviderSelection(root, 'coding', 'invalid stale value'); expect(readWorkflowProviderSelection(root, 'coding').providerId).toBe('example.explicit/policy'); expect(readWorkflowProviderSelection(root, 'review').providerId).toBe(DEFAULT_WORKFLOW_PROVIDERS.review);
  await pluginCommand(['--dir', root, 'select-workflow', 'coding', 'default'], { coordinate: false }); initializeWorkflowProviderSelection(root, 'coding', 'example.legacy/policy'); expect(readWorkflowProviderSelection(root, 'coding').providerId).toBeNull();
  await pluginCommand(['--dir', root, 'select-workflow', 'branch', 'null'], { coordinate: false }); expect(readWorkflowProviderSelection(root, 'branch').providerId).toBeNull();
  await expect(pluginCommand(['--dir', root, 'select-workflow', 'unknown', 'default'], { coordinate: false })).rejects.toThrow();
  expect(() => initializeWorkflowSettings(root, pkg, { credential: 'unknown' })).toThrow('Unknown');
  writePluginSettings(root, pkg, { prompt: 'explicit' }); initializeWorkflowSettings(root, pkg, { prompt: 'legacy' }); expect(readPluginSettings(root, pkg).prompt).toBe('explicit');
  clearPluginSettings(root, pkg.manifest.id); initializeWorkflowSettings(root, pkg, { prompt: 'later' }); expect(readPluginSettings(root, pkg).prompt).toBe('original');
  expect(() => initializeWorkflowSettings(root, pkg, { prompt: 123, credential: 'stale invalid value' })).not.toThrow(); expect(readPluginSettings(root, pkg).prompt).toBe('original');
});
it('loads builtin providers from verified retained runtime after original source deletion', async () => {
  const root = await temporary(); const original = join(root, 'original'); const runtimeArtifactsRoot = join(root, 'retained');
  await mkdir(join(original, 'server', 'helmsman', 'plugins'), { recursive: true });
  await writeFile(join(original, 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', type: 'module' }));
  await writeFile(join(original, 'server', 'helmsman', 'main.js'), 'export {};'); const pkg = descriptor('helmsman.original-workflow');
  const catalog = `const plugin = ${source.replace('export default ', '').replace(/;$/, '')}; export const builtinWorkflows = [{ package: ${JSON.stringify(pkg)}, module: plugin }];`;
  await writeFile(join(original, 'server', 'helmsman', 'plugins', 'builtin-workflows.js'), catalog);
  const retained = await retainLegacyRuntime(original, runtimeArtifactsRoot); await rm(original, { recursive: true });
  const record = parseWorkflowRetainedProviderV1({ version: 1, binding: { providerId: 'helmsman.original-workflow/policy', pluginId: 'helmsman.original-workflow', artifactHash: retained.artifact.artifactHash, contractVersion: 1 }, origin: 'builtin', settings: { prompt: 'saved' }, metadata });
  const artifacts = [retained.artifact, { pluginId: record.binding.pluginId, artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [retained.artifact.pluginId] }];
  const loaded = await loadRetainedWorkflowProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts }); expect(loaded.provider.renderPrompt(promptInput)).toBe('saved'); await loaded.dispose();
  await writeFile(join(retained.root, 'server', 'helmsman', 'plugins', 'builtin-workflows.js'), `${catalog}\n `);
  await expect(loadRetainedWorkflowProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts })).rejects.toThrow('unavailable');
});

it('migrates implicit workflow reviewers once and preserves writer, explicit order and subsequent resets', async () => {
  const root = await temporary(); selectAgentProvider(root, 'example.writer/agent');
  const before = readAgentProviderSelection(root);
  for (const invalid of [[], ['invalid'], ['example.review/agent', 'example.review/agent'], Array.from({ length: 9 }, (_, index) => `example.review/agent${index}`)]) {
    expect(() => initializeWorkflowReviewerSelection(root, invalid)).toThrow('Invalid initial');
    expect(readAgentProviderSelection(root)).toEqual(before);
  }
  initializeWorkflowReviewerSelection(root, ['example.second/agent', 'example.first/agent']);
  const migrated = readAgentProviderSelection(root);
  expect(migrated.writer).toBe('example.writer/agent'); expect(migrated.reviewers).toEqual(['example.second/agent', 'example.first/agent']); expect(migrated.revision).not.toBe(before.revision);
  initializeWorkflowReviewerSelection(root, ['example.later/agent']); expect(readAgentProviderSelection(root)).toEqual(migrated);
  selectAgentReviewers(root, null); const reset = readAgentProviderSelection(root);
  initializeWorkflowReviewerSelection(root, ['invalid stale environment']); expect(readAgentProviderSelection(root)).toEqual(reset);
  const explicitRoot = await temporary(); selectAgentProvider(explicitRoot, 'example.explicit/agent'); selectAgentReviewers(explicitRoot, ['example.keep/agent']);
  const explicit = readAgentProviderSelection(explicitRoot); initializeWorkflowReviewerSelection(explicitRoot, ['example.default/agent']); expect(readAgentProviderSelection(explicitRoot)).toEqual(explicit);
  selectAgentReviewers(explicitRoot, null); initializeWorkflowReviewerSelection(explicitRoot, ['example.default/agent']); expect(readAgentProviderSelection(explicitRoot).reviewers).toBeNull();
});

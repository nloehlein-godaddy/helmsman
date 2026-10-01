import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSdkCompatibility } from './sdk-compatibility.mjs';

test('task-action permission extension preserves existing manifest inputs without broadening other contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-task-action-compat-'));
  try {
    const baseline = join(root, 'baseline'); const candidate = join(root, 'candidate');
    const contract = `
export interface PluginServiceRequirementV1 { readonly id: 'helmsman/task-read'; readonly version: 1; }
export interface PluginPanelDefinition { readonly id: string; readonly requires: readonly PluginServiceRequirementV1[]; }
export interface PluginPageDefinition { readonly id: string; readonly requires?: readonly PluginServiceRequirementV1[]; }
export interface PluginManifestV2 { readonly pages: readonly PluginPageDefinition[]; readonly panels: readonly PluginPanelDefinition[]; }
export interface CompositionServiceV1 { discover(): readonly PluginPanelDefinition[]; }
export interface PluginPageContext { readonly composition?: CompositionServiceV1; }
export interface PluginPageModule { mount(container: string, context: PluginPageContext): void; }
export interface OtherRequirement { readonly id: 'helmsman/task-read'; readonly version: 1; }
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory); await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};'); await writeFile(join(directory, 'index.d.ts'), contract);
    }
    const extended = contract.replace("id: 'helmsman/task-read';", "id: 'helmsman/task-read' | 'helmsman/task-action';");
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 8);
    await writeFile(join(candidate, 'index.d.ts'), extended.replace("'helmsman/task-action'", "'helmsman/task-action' | 'helmsman/execution-policy'"));
    assert.equal(checkSdkCompatibility(baseline, candidate), 8);
    for (const broken of [
      extended.replace("'helmsman/task-read' | ", ''),
      extended.replace("'helmsman/task-action'", "'helmsman/arbitrary-action'"),
      extended.replace("'helmsman/task-action'", "'helmsman/task-action' | 'helmsman/arbitrary-action'"),
      extended.replace('readonly version: 1', 'readonly version: 2'),
      extended.replace('readonly id: string', 'readonly id: number'),
      extended.replace("OtherRequirement { readonly id: 'helmsman/task-read'", "OtherRequirement { readonly id: 'helmsman/task-read' | 'helmsman/task-action'"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run-instructions permission extension preserves existing manifest inputs without broadening other contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-run-instructions-compat-'));
  try {
    const baseline = join(root, 'baseline'); const candidate = join(root, 'candidate');
    const contract = `
export interface PluginServiceRequirementV1 { readonly id: 'helmsman/task-read'; readonly version: 1; }
export interface PluginPanelDefinition { readonly id: string; readonly requires: readonly PluginServiceRequirementV1[]; }
export interface PluginPageDefinition { readonly id: string; readonly requires?: readonly PluginServiceRequirementV1[]; }
export interface PluginManifestV2 { readonly pages: readonly PluginPageDefinition[]; readonly panels: readonly PluginPanelDefinition[]; }
export interface CompositionServiceV1 { discover(): readonly PluginPanelDefinition[]; }
export interface PluginPageContext { readonly composition?: CompositionServiceV1; }
export interface PluginPageModule { mount(container: string, context: PluginPageContext): void; }
export interface OtherRequirement { readonly id: 'helmsman/task-read'; readonly version: 1; }
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory); await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};'); await writeFile(join(directory, 'index.d.ts'), contract);
    }
    const extended = contract.replace("id: 'helmsman/task-read';", "id: 'helmsman/task-read' | 'helmsman/run-instructions';");
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 8);
    for (const broken of [
      extended.replace("'helmsman/task-read' | ", ''),
      extended.replace("'helmsman/run-instructions'", "'helmsman/arbitrary-action'"),
      extended.replace("'helmsman/run-instructions'", "'helmsman/run-instructions' | 'helmsman/arbitrary-action'"),
      extended.replace('readonly version: 1', 'readonly version: 2'),
      extended.replace('readonly id: string', 'readonly id: number'),
      extended.replace("OtherRequirement { readonly id: 'helmsman/task-read'", "OtherRequirement { readonly id: 'helmsman/task-read' | 'helmsman/run-instructions'"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SDK baseline rejects removed exports and incompatible signatures while accepting optional additions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-compat-'));
  try {
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    const contract = 'export interface Service { read: (id: string) => Promise<string>; }\nexport declare function parse(value: unknown): Service;\nexport type Result<T> = { value: T };';
    for (const directory of [baseline, candidate]) {
      await mkdir(directory);
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};');
      await writeFile(join(directory, 'index.d.ts'), contract);
    }
    assert.equal(checkSdkCompatibility(baseline, candidate), 3);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('read: ', 'cancel?: () => void; read: ') + '\nexport type NewValue = string;');
    assert.equal(checkSdkCompatibility(baseline, candidate), 3);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('id: string', 'id: number'));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('export declare function parse(value: unknown): Service;', ''));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /removed export parse/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('Promise<string>', 'Promise<number>'));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('value: T', 'value: string'));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('read: (id: string) => Promise<string>;', ''));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract);
    await writeFile(join(baseline, 'node.d.ts'), 'export declare function stop(id: string): Promise<void>;');
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /removed export stop/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SDK communication manifest extension preserves old inputs and rejects unrelated widening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-communication-compat-'));
  try {
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    const contract = `
export interface CommunicationProviderDeclaration { readonly access: readonly ['browser-session']; }
export interface PluginBackendDefinition { readonly entry: string; readonly communications?: Readonly<Record<string, CommunicationProviderDeclaration>>; }
export interface OtherDeclaration { readonly access: readonly ['browser-session']; }
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory);
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};');
      await writeFile(join(directory, 'index.d.ts'), contract);
    }
    const extended = contract.replace("readonly ['browser-session'];", "readonly ['browser-session'] | readonly ['provider-network'];");
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 3);
    for (const broken of [
      extended.replace('readonly entry: string', 'readonly entry: number'),
      extended.replace(" | readonly ['provider-network']", " | readonly ['arbitrary-access']"),
      extended.replace("readonly ['browser-session'] | readonly ['provider-network']", "readonly ['provider-network']"),
      extended.replace("readonly ['browser-session'] | readonly ['provider-network']", "readonly ['browser-session'] | readonly ['provider-network'] | readonly ['extra-access']"),
      extended.replace("OtherDeclaration { readonly access: readonly ['browser-session']", "OtherDeclaration { readonly access: readonly ['browser-session'] | readonly ['provider-network']"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Local Git release extension preserves existing operations and rejects unrelated contract drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-local-git-compat-'));
  try {
    const baseline = join(root, 'baseline'); const candidate = join(root, 'candidate');
    const original = `
export type LocalGitAction = { action: 'delete-worktree'; path: string; expectedCommit: string };
export interface LocalGitControlInputV1 { operation: LocalGitAction; }
export interface LocalGitControlReceiptV1 { input: LocalGitControlInputV1; status: 'succeeded' | 'rejected'; }
export interface LocalGitServiceV1 { control(input: LocalGitControlInputV1): Promise<LocalGitControlReceiptV1>; }
export interface PluginPageServices { localGit?: LocalGitServiceV1; other: string; }
export interface PluginPageContext { services?: PluginPageServices; }
export declare function parseLocalGitControlReceiptV1(input: unknown, expected?: LocalGitControlInputV1): LocalGitControlReceiptV1;
export type UnrelatedAction = { action: 'delete-worktree'; path: string; expectedCommit: string };
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory); await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};'); await writeFile(join(directory, 'index.d.ts'), original);
    }
    const release = " | { action: 'release-worktree'; path: string; expectedCommit: string; expectedBranch: string }";
    const extended = original.replace('expectedCommit: string };', `expectedCommit: string }${release};`);
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 8);
    for (const broken of [
      extended.replace("action: 'delete-worktree'", "action: 'removed-worktree'"),
      extended.replace('expectedBranch: string', 'expectedBranch: number'),
      extended.replace('expectedBranch: string', 'expectedBranch: string; force?: boolean'),
      extended.replace('other: string', 'other: number'),
      extended.replace("status: 'succeeded' | 'rejected'", "status: 'succeeded' | 'rejected' | 'unknown'"),
      extended.replace("export type UnrelatedAction =", "export type UnrelatedAction = { action: 'release-worktree'; path: string; expectedCommit: string; expectedBranch: string } |"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('feedback permission extension preserves existing manifest inputs without broadening other contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-feedback-compat-'));
  try {
    const baseline = join(root, 'baseline'); const candidate = join(root, 'candidate');
    const contract = `
export interface PluginServiceRequirementV1 { readonly id: 'helmsman/task-read'; readonly version: 1; }
export interface PluginPanelDefinition { readonly id: string; readonly requires: readonly PluginServiceRequirementV1[]; }
export interface PluginPageDefinition { readonly id: string; readonly requires?: readonly PluginServiceRequirementV1[]; }
export interface PluginManifestV2 { readonly pages: readonly PluginPageDefinition[]; readonly panels: readonly PluginPanelDefinition[]; }
export interface CompositionServiceV1 { discover(): readonly PluginPanelDefinition[]; }
export interface PluginPageContext { readonly composition?: CompositionServiceV1; }
export interface PluginPageModule { mount(container: string, context: PluginPageContext): void; }
export interface OtherRequirement { readonly id: 'helmsman/task-read'; readonly version: 1; }
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory); await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};'); await writeFile(join(directory, 'index.d.ts'), contract);
    }
    const extended = contract.replace("id: 'helmsman/task-read';", "id: 'helmsman/task-read' | 'helmsman/feedback-command' | 'helmsman/feedback-settings';");
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 8);
    for (const broken of [
      extended.replace("'helmsman/task-read' | ", ''),
      extended.replace("'helmsman/feedback-command'", "'helmsman/arbitrary-action'"),
      extended.replace("'helmsman/feedback-command'", "'helmsman/feedback-command' | 'helmsman/arbitrary-action'"),
      extended.replace('readonly version: 1', 'readonly version: 2'),
      extended.replace('readonly id: string', 'readonly id: number'),
      extended.replace("OtherRequirement { readonly id: 'helmsman/task-read'", "OtherRequirement { readonly id: 'helmsman/task-read' | 'helmsman/feedback-command'"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SDK baseline rejects removed exports and incompatible signatures while accepting optional additions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-compat-'));
  try {
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    const contract = 'export interface Service { read: (id: string) => Promise<string>; }\nexport declare function parse(value: unknown): Service;\nexport type Result<T> = { value: T };';
    for (const directory of [baseline, candidate]) {
      await mkdir(directory);
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};');
      await writeFile(join(directory, 'index.d.ts'), contract);
    }
    assert.equal(checkSdkCompatibility(baseline, candidate), 3);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('read: ', 'cancel?: () => void; read: ') + '\nexport type NewValue = string;');
    assert.equal(checkSdkCompatibility(baseline, candidate), 3);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('id: string', 'id: number'));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('export declare function parse(value: unknown): Service;', ''));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /removed export parse/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('Promise<string>', 'Promise<number>'));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('value: T', 'value: string'));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract.replace('read: (id: string) => Promise<string>;', ''));
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    await writeFile(join(candidate, 'index.d.ts'), contract);
    await writeFile(join(baseline, 'node.d.ts'), 'export declare function stop(id: string): Promise<void>;');
    assert.throws(() => checkSdkCompatibility(baseline, candidate), /removed export stop/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SDK communication manifest extension preserves old inputs and rejects unrelated widening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-communication-compat-'));
  try {
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    const contract = `
export interface CommunicationProviderDeclaration { readonly access: readonly ['browser-session']; }
export interface PluginBackendDefinition { readonly entry: string; readonly communications?: Readonly<Record<string, CommunicationProviderDeclaration>>; }
export interface OtherDeclaration { readonly access: readonly ['browser-session']; }
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory);
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};');
      await writeFile(join(directory, 'index.d.ts'), contract);
    }
    const extended = contract.replace("readonly ['browser-session'];", "readonly ['browser-session'] | readonly ['provider-network'];");
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 3);
    for (const broken of [
      extended.replace('readonly entry: string', 'readonly entry: number'),
      extended.replace(" | readonly ['provider-network']", " | readonly ['arbitrary-access']"),
      extended.replace("readonly ['browser-session'] | readonly ['provider-network']", "readonly ['provider-network']"),
      extended.replace("readonly ['browser-session'] | readonly ['provider-network']", "readonly ['browser-session'] | readonly ['provider-network'] | readonly ['extra-access']"),
      extended.replace("OtherDeclaration { readonly access: readonly ['browser-session']", "OtherDeclaration { readonly access: readonly ['browser-session'] | readonly ['provider-network']"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Local Git release extension preserves existing operations and rejects unrelated contract drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-sdk-local-git-compat-'));
  try {
    const baseline = join(root, 'baseline'); const candidate = join(root, 'candidate');
    const original = `
export type LocalGitAction = { action: 'delete-worktree'; path: string; expectedCommit: string };
export interface LocalGitControlInputV1 { operation: LocalGitAction; }
export interface LocalGitControlReceiptV1 { input: LocalGitControlInputV1; status: 'succeeded' | 'rejected'; }
export interface LocalGitServiceV1 { control(input: LocalGitControlInputV1): Promise<LocalGitControlReceiptV1>; }
export interface PluginPageServices { localGit?: LocalGitServiceV1; other: string; }
export interface PluginPageContext { services?: PluginPageServices; }
export declare function parseLocalGitControlReceiptV1(input: unknown, expected?: LocalGitControlInputV1): LocalGitControlReceiptV1;
export type UnrelatedAction = { action: 'delete-worktree'; path: string; expectedCommit: string };
`;
    for (const directory of [baseline, candidate]) {
      await mkdir(directory); await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'node.d.ts'), 'export {};'); await writeFile(join(directory, 'index.d.ts'), original);
    }
    const release = " | { action: 'release-worktree'; path: string; expectedCommit: string; expectedBranch: string }";
    const extended = original.replace('expectedCommit: string };', `expectedCommit: string }${release};`);
    await writeFile(join(candidate, 'index.d.ts'), extended);
    assert.equal(checkSdkCompatibility(baseline, candidate), 8);
    for (const broken of [
      extended.replace("action: 'delete-worktree'", "action: 'removed-worktree'"),
      extended.replace('expectedBranch: string', 'expectedBranch: number'),
      extended.replace('expectedBranch: string', 'expectedBranch: string; force?: boolean'),
      extended.replace('other: string', 'other: number'),
      extended.replace("status: 'succeeded' | 'rejected'", "status: 'succeeded' | 'rejected' | 'unknown'"),
      extended.replace("export type UnrelatedAction =", "export type UnrelatedAction = { action: 'release-worktree'; path: string; expectedCommit: string; expectedBranch: string } |"),
    ]) {
      await writeFile(join(candidate, 'index.d.ts'), broken);
      assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('feedback backend capability extension excludes only the exact new capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-feedback-capability-'));
  try {
    const baseline = join(root, 'baseline'); const candidate = join(root, 'candidate');
    const contract = "export interface PluginBackendDefinition { readonly entry: string; readonly provides: readonly { readonly id: 'helmsman/pricing'; readonly version: 1 }[]; }";
    for (const directory of [baseline, candidate]) { await mkdir(directory); await writeFile(join(directory, 'package.json'), '{"type":"module"}'); await writeFile(join(directory, 'node.d.ts'), 'export {};'); await writeFile(join(directory, 'index.d.ts'), contract); }
    const extended = contract.replace("'helmsman/pricing'", "'helmsman/pricing' | 'helmsman/feedback-tracker'");
    await writeFile(join(candidate, 'index.d.ts'), extended); assert.equal(checkSdkCompatibility(baseline, candidate), 1);
    for (const broken of [extended.replace("'helmsman/pricing' | ", ''), extended.replace('readonly version: 1', 'readonly version: 2'), extended.replace("'helmsman/feedback-tracker'", "'helmsman/arbitrary-tracker'"), extended.replace('readonly entry: string', 'readonly entry: number')]) {
      await writeFile(join(candidate, 'index.d.ts'), broken); assert.throws(() => checkSdkCompatibility(baseline, candidate), /SDK compatibility check failed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

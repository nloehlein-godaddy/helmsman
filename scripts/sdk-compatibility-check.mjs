import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSdkCompatibility } from './sdk-compatibility.mjs';

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

// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retainLegacyRuntime, verifyLegacyRuntime } from './legacy-runtime-artifact';

let directory: string;
let source: string;
let artifacts: string;
async function file(path: string, contents: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'helmsman-retained-runtime-')); source = join(directory, 'source'); artifacts = join(directory, 'artifacts'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture(mode: 'source' | 'compiled' = 'compiled') {
  await file(join(source, 'package.json'), JSON.stringify({ name: 'helmsman', version: '1.0.0', type: 'module', dependencies: { 'fixture-runtime': '1.0.0' } }));
  await file(join(source, 'server', 'helmsman', mode === 'source' ? 'main.ts' : 'main.js'), "import value from 'fixture-runtime'; process.stdout.write(value);\n");
  await file(join(source, 'node_modules', 'fixture-runtime', 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', main: 'index.cjs', dependencies: { 'fixture-helper': '1.0.0' } }));
  await file(join(source, 'node_modules', 'fixture-runtime', 'index.cjs'), "module.exports = require('fixture-helper');\n");
  await file(join(source, 'node_modules', 'fixture-helper', 'package.json'), JSON.stringify({ name: 'fixture-helper', version: '1.0.0', main: 'index.cjs' }));
  await file(join(source, 'node_modules', 'fixture-helper', 'index.cjs'), "module.exports = 'retained-closure';\n");
  await file(join(source, '.env'), 'JIRA_API_TOKEN=never-copy');
  await file(join(source, 'server', 'helmsman', '.env.local'), 'SECRET=never-copy');
  await file(join(source, 'server', 'helmsman', 'runtime.sqlite'), 'never-copy-runtime');
  await file(join(source, 'server', 'helmsman', 'main.test.ts'), 'test-only');
  if (mode === 'source') {
    await file(join(source, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2023"}}');
    await file(join(source, 'node_modules', 'tsx', 'package.json'), JSON.stringify({ name: 'tsx', version: '1.0.0', main: 'index.cjs' }));
    await file(join(source, 'node_modules', 'tsx', 'index.cjs'), 'module.exports = {};');
  }
}

describe('retained legacy executable artifacts', () => {
  it('retains compiled runtime and transitive package bytes runnable with the source removed', async () => {
    await fixture();
    const retained = await retainLegacyRuntime(source, artifacts);
    await rm(source, { recursive: true, force: true });
    const result = await promisify(execFile)(process.execPath, [retained.entry], { cwd: retained.root });
    expect(result.stdout).toBe('retained-closure');
    expect(await verifyLegacyRuntime(artifacts, retained.artifact.artifactHash)).toEqual(retained);
    const manifest = JSON.parse(await readFile(join(retained.root, '.helmsman-runtime.json'), 'utf8')) as { files: Array<{ path: string }> };
    expect(manifest.files.some(item => /env|sqlite|test\.ts/.test(item.path))).toBe(false);
  });

  it('retains source mode and its TypeScript loader separately from compiled artifacts', async () => {
    await fixture('source');
    const retained = await retainLegacyRuntime(source, artifacts);
    expect(retained.mode).toBe('source'); expect(retained.entry.endsWith('main.ts')).toBe(true);
    expect(await readFile(join(retained.root, 'node_modules', 'tsx', 'index.cjs'), 'utf8')).toBe('module.exports = {};');
    expect(await readFile(join(retained.root, 'tsconfig.json'), 'utf8')).toContain('ES2023');
  });

  it('deduplicates identical bytes and keeps old artifacts verifiable after current source changes', async () => {
    await fixture();
    const original = await retainLegacyRuntime(source, artifacts);
    expect(await retainLegacyRuntime(source, artifacts)).toEqual(original);
    await file(join(source, 'node_modules', 'fixture-helper', 'index.cjs'), "module.exports = 'new-runtime';\n");
    const updated = await retainLegacyRuntime(source, artifacts);
    expect(updated.artifact.artifactHash).not.toBe(original.artifact.artifactHash);
    expect(await verifyLegacyRuntime(artifacts, original.artifact.artifactHash)).toEqual(original);
  });

  it('blocks missing, corrupted, injected and symlinked artifacts without substituting the current runtime', async () => {
    await fixture();
    const retained = await retainLegacyRuntime(source, artifacts);
    expect(await verifyLegacyRuntime(artifacts, 'f'.repeat(64))).toBeNull();
    await file(join(retained.root, 'injected.js'), 'untracked');
    expect(await verifyLegacyRuntime(artifacts, retained.artifact.artifactHash)).toBeNull();
    await rm(join(retained.root, 'injected.js'));
    await file(retained.entry, 'changed');
    expect(await verifyLegacyRuntime(artifacts, retained.artifact.artifactHash)).toBeNull();
    await rm(retained.entry); await symlink(join(source, 'server', 'helmsman', 'main.js'), retained.entry);
    expect(await verifyLegacyRuntime(artifacts, retained.artifact.artifactHash)).toBeNull();
  });

  it('rejects source symlinks and artifact storage inside copied executable directories', async () => {
    await fixture();
    await expect(retainLegacyRuntime(source, join(source, 'server', 'artifacts'))).rejects.toThrow('conflicts');
    await symlink(join(source, '.env'), join(source, 'server', 'secret.js'));
    await expect(retainLegacyRuntime(source, artifacts)).rejects.toThrow('symlink');
  });
});

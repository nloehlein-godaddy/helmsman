// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installPluginArtifact, packPluginDirectory, parsePluginArchive, readPluginArtifact } from './artifacts';

const roots: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-artifacts-'));
  roots.push(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function descriptor() {
  return { packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'acme.example', version: '1.0.0', sdkVersion: 1,
      pages: [{ id: 'example', title: 'Example', slots: [], panes: [] }] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { example: 'page.js' } };
}
function file(path = 'page.js', text = 'export const answer = 42;') {
  return { path, base64: Buffer.from(text).toString('base64') };
}
function archive() { return { format: 'helmsman-plugin', version: 1, package: descriptor(), files: [file()] }; }
function bytes(value: unknown) { return Buffer.from(JSON.stringify(value)); }

describe('plugin artifacts', () => {
  it('canonicalizes property order, whitespace, entry order, and lexical file order', () => {
    const input = archive();
    input.files = [file('z.css'), file(), file('a.css')];
    const first = parsePluginArchive(bytes(input));
    const second = parsePluginArchive(JSON.stringify({ files: [...input.files].reverse(), package: input.package,
      version: 1, format: 'helmsman-plugin' }, null, 2));
    expect(first.hash).toBe(second.hash);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect([...first.files.keys()]).toEqual(['a.css', 'page.js', 'z.css']);
    expect(Buffer.from(first.files.get('page.js') ?? []).toString()).toBe('export const answer = 42;');
  });

  it.each([{ format: 'tar' }, { version: 2 }, { extra: true }, { files: null }, { files: [] },
    { files: [file(), file()] }, { files: [file('../page.js')] },
    { files: [{ ...file(), extra: true }] }, { files: [{ path: 'page.js' }] }])('rejects malformed archive %j', override => {
    expect(() => parsePluginArchive(bytes({ ...archive(), ...override }))).toThrow();
  });

  it.each(['YQ', 'YQ=', 'YQ===', 'YR==', 'Y Q==', 'YQ==\n', '____', '=AAA'])('rejects noncanonical base64 %j', base64 => {
    expect(() => parsePluginArchive(bytes({ ...archive(), files: [{ path: 'page.js', base64 }] }))).toThrow(/base64/);
  });

  it('rejects invalid JSON and malformed UTF-8', () => {
    expect(() => parsePluginArchive('{')).toThrow(/JSON/);
    expect(() => parsePluginArchive(Buffer.from([0xff]))).toThrow(/UTF-8/);
  });

  it('enforces file count and both archive size limits', () => {
    expect(() => parsePluginArchive(bytes({ ...archive(), files: [file(), ...Array.from({ length: 128 }, (_, i) => file(`${i}.js`))] }))).toThrow(/128/);
    expect(() => parsePluginArchive(bytes({ ...archive(), files: [file('page.js', 'x'.repeat(10 * 1024 * 1024 + 1))] }))).toThrow(/decoded/);
    expect(() => parsePluginArchive(' '.repeat(15 * 1024 * 1024 + 1))).toThrow(/serialized/);
  });

  it('packs nested regular files without executing their code', async () => {
    const root = await temporary();
    await writeFile(join(root, 'plugin-package.json'), JSON.stringify(descriptor()));
    await writeFile(join(root, 'page.js'), 'throw new Error("must not execute")');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'style.css'), 'body {}');
    const result = await packPluginDirectory(root);
    expect([...result.files.keys()]).toEqual(['assets/style.css', 'page.js']);
    expect(result.package.manifest.id).toBe('acme.example');
  });

  it('rejects symlink files, descriptor symlinks, and ancestor symlinks', async () => {
    const root = await temporary();
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(source, 'plugin-package.json'), JSON.stringify(descriptor()));
    await writeFile(join(source, 'page.js'), 'export {}');
    await symlink(source, join(root, 'alias'));
    await expect(packPluginDirectory(join(root, 'alias'))).rejects.toThrow(/symlink/);
    await symlink(join(source, 'page.js'), join(source, 'link.js'));
    await expect(packPluginDirectory(source)).rejects.toThrow(/symlink/);
    await rm(join(source, 'link.js'));
    await rm(join(source, 'plugin-package.json'));
    await writeFile(join(root, 'descriptor.json'), JSON.stringify(descriptor()));
    await symlink(join(root, 'descriptor.json'), join(source, 'plugin-package.json'));
    await expect(packPluginDirectory(source)).rejects.toThrow(/symlink/);
  });

  it('rejects an oversized source before allocating its contents', async () => {
    const root = await temporary();
    await writeFile(join(root, 'plugin-package.json'), JSON.stringify(descriptor()));
    await writeFile(join(root, 'page.js'), '');
    await truncate(join(root, 'page.js'), 100 * 1024 * 1024);
    await expect(packPluginDirectory(root)).rejects.toThrow(/size/);
  });

  it('publishes immutable canonical artifacts and handles concurrent installs', async () => {
    const root = join(await temporary(), 'registry');
    const input = bytes(archive());
    const results = await Promise.all([installPluginArtifact(root, input), installPluginArtifact(root, input)]);
    expect(results[0]?.hash).toBe(results[1]?.hash);
    const hash = results[0]!.hash;
    expect((await readPluginArtifact(root, hash)).bytes.equals(results[0]!.bytes)).toBe(true);
    expect(await readdir(join(root, 'artifacts'))).toEqual([`${hash}.json`]);
    expect((await readFile(join(root, 'artifacts', `${hash}.json`))).equals(results[0]!.bytes)).toBe(true);
  });

  it('detects existing artifact corruption without replacing it', async () => {
    const root = await temporary();
    const input = bytes(archive());
    const installed = await installPluginArtifact(root, input);
    const path = join(root, 'artifacts', `${installed.hash}.json`);
    const changed = archive();
    changed.files = [file('page.js', 'different')];
    await writeFile(path, bytes(changed));
    await expect(readPluginArtifact(root, installed.hash)).rejects.toThrow(/integrity/);
    await expect(installPluginArtifact(root, input)).rejects.toThrow(/integrity/);
    expect((await readFile(path)).equals(bytes(changed))).toBe(true);
    expect(await readdir(join(root, 'artifacts'))).toEqual([`${installed.hash}.json`]);
  });

  it('rejects symlink artifact directories before creating files elsewhere', async () => {
    const root = await temporary();
    const target = await temporary();
    await symlink(target, join(root, 'artifacts'));
    await expect(installPluginArtifact(root, bytes(archive()))).rejects.toThrow(/symlink/);
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects invalid hashes before filesystem access', async () => {
    await expect(readPluginArtifact('/missing', '../escape')).rejects.toThrow(/hash/);
    await expect(readPluginArtifact('/missing', `${'a'.repeat(64)}\n`)).rejects.toThrow(/hash/);
  });
});

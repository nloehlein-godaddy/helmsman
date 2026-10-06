/** @vitest-environment node */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOwnedDirectory, ensureOwnedRoot, OwnedPathError, readOwnedFile, removeOwnedEntry, writeOwnedFile } from './owned-paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'hm-owned-')); roots.push(base);
  const root = join(base, 'owned'); mkdirSync(root);
  const outside = join(base, 'outside'); mkdirSync(join(outside, 'skills'), { recursive: true });
  writeFileSync(join(outside, 'skills', 'keep.txt'), 'keep'); writeFileSync(join(outside, 'secret'), 'secret');
  return { base, root, outside };
}

describe('Helmsman-owned paths', () => {
  it('replaces symlinked and non-directory components with real 0700 directories', () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, 'provider-home'));
    expect(ensureOwnedDirectory(root, 'provider-home', 'codex')).toBe(join(root, 'provider-home', 'codex'));
    expect(lstatSync(join(root, 'provider-home')).isDirectory()).toBe(true);
    expect(statSync(join(root, 'provider-home', 'codex')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(outside, 'skills', 'keep.txt'), 'utf8')).toBe('keep');
    writeFileSync(join(root, 'patches'), 'not a dir');
    ensureOwnedDirectory(root, 'patches');
    expect(lstatSync(join(root, 'patches')).isDirectory()).toBe(true);
  });

  it('keeps an existing real directory and its contents', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'provider-home', 'codex', 'sessions'), { recursive: true });
    ensureOwnedDirectory(root, 'provider-home', 'codex');
    expect(lstatSync(join(root, 'provider-home', 'codex', 'sessions')).isDirectory()).toBe(true);
  });

  it('rejects segments that would leave the root', () => {
    const { root } = fixture();
    for (const segment of ['..', '.', '', 'a/b']) expect(() => ensureOwnedDirectory(root, segment)).toThrow(OwnedPathError);
  });

  it('resets a symlinked root without touching its target', () => {
    const { base, outside } = fixture();
    const root = join(base, 'swapped');
    symlinkSync(outside, root);
    ensureOwnedRoot(root);
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('secret');
  });

  it('writes through neither a planted file symlink nor a planted directory', () => {
    const { root, outside } = fixture();
    symlinkSync(join(outside, 'secret'), join(root, 'seed.md'));
    writeOwnedFile(root, join(root, 'seed.md'), 'seed');
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('secret');
    expect(lstatSync(join(root, 'seed.md')).isFile()).toBe(true);
    expect(statSync(join(root, 'seed.md')).mode & 0o777).toBe(0o600);
    mkdirSync(join(root, 'evidence.json'));
    writeOwnedFile(root, join(root, 'evidence.json'), '{}');
    expect(readFileSync(join(root, 'evidence.json'), 'utf8')).toBe('{}');
  });

  it('refuses to write or remove when the parent resolves outside the root', () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, 'home'));
    expect(() => writeOwnedFile(root, join(root, 'home', 'secret'), 'x')).toThrow(OwnedPathError);
    expect(() => removeOwnedEntry(root, join(root, 'home', 'skills'))).toThrow(OwnedPathError);
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('secret');
    expect(readFileSync(join(outside, 'skills', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('removes a symlinked entry without following it', () => {
    const { root, outside } = fixture();
    symlinkSync(join(outside, 'skills'), join(root, 'skills'));
    removeOwnedEntry(root, join(root, 'skills'));
    expect(lstatSync(join(root, 'skills'), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(outside, 'skills', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('reads regular files but never follows a final symlink', () => {
    const { root, outside } = fixture();
    writeFileSync(join(root, 'seed.md'), 'seed');
    expect(readOwnedFile(join(root, 'seed.md'))).toBe('seed');
    symlinkSync(join(outside, 'secret'), join(root, 'link.md'));
    expect(readOwnedFile(join(root, 'link.md'))).toBeNull();
    expect(readOwnedFile(join(root, 'missing.md'))).toBeNull();
    expect(readOwnedFile(root)).toBeNull();
  });
});

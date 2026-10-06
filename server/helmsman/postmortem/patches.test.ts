/** @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitBin } from '../../test-support/platform';
import { listPatches, validatePatch } from './patches';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const GIT = gitBin();
const diff = (from: string, to: string) => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hm-pm-patches-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync(GIT, ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n'); git('commit', '-am', 'later');
  const directory = join(root, 'run.postmortem'); mkdirSync(join(directory, 'patches'), { recursive: true });
  const put = (name: string, patch: string, sidecar?: unknown) => {
    writeFileSync(join(directory, 'patches', `${name}.patch`), patch);
    if (sidecar !== undefined) writeFileSync(join(directory, 'patches', `${name}.json`), typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar));
  };
  return { root, repo, git, base, directory, put };
}

describe('post-mortem patches', () => {
  it('validates against a temporary index at the base without touching the repository', async () => {
    const f = fixture();
    const patch = join(f.directory, 'patches', 'p.patch'); writeFileSync(patch, diff('one', 'three'));
    expect(await validatePatch(f.repo, f.base, patch, GIT)).toBeNull();
    writeFileSync(patch, diff('zzz', 'three'));
    expect(await validatePatch(f.repo, f.base, patch, GIT)).toMatch(/^does not apply: /);
    expect(await validatePatch(f.repo, 'f'.repeat(40), patch, GIT)).toBe('base not found');
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe('two\n');
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it('lists patches in order with apply commands and badges', async () => {
    const f = fixture();
    f.put('10-target', diff('one', 'ten'), { repo: 'target', baseSha: f.base, summary: 'Ten' });
    f.put('2-target', diff('zzz', 'two'), { repo: 'target', baseSha: f.base, summary: 'Conflicts' });
    f.put('2-helmsman', diff('one', 'h'), { repo: 'helmsman', baseSha: f.base, summary: 'Chunk argv' });
    const patches = await listPatches(f.directory, { helmsman: f.repo, target: null }, GIT);
    expect(patches.map(patch => [patch.file, patch.valid, patch.reason])).toEqual([
      ['2-helmsman.patch', true, null], ['2-target.patch', false, 'repository not available'], ['10-target.patch', false, 'repository not available']]);
    expect(patches[0]).toMatchObject({ number: 2, repo: 'helmsman', baseSha: f.base, summary: 'Chunk argv',
      applyCommand: `git -C '${f.repo}' apply '${join(f.directory, 'patches', '2-helmsman.patch')}'` });
    const both = await listPatches(f.directory, { helmsman: f.repo, target: f.repo }, GIT);
    expect(both.map(patch => patch.valid)).toEqual([true, false, true]);
  });

  it('tolerates junk in the patch directory', async () => {
    const f = fixture();
    f.put('evil', diff('one', 'x'), { repo: 'target', baseSha: f.base, summary: '' });
    f.put('3-other', diff('one', 'x'), { repo: 'target', baseSha: f.base, summary: '' });
    f.put('4-target', diff('one', 'x'), { repo: 'helmsman', baseSha: f.base, summary: 'label mismatch' });
    f.put('5-target', diff('one', 'x'));
    f.put('6-target', diff('one', 'x'), '{not json');
    f.put('7-target', 'x'.repeat(1_048_577), { repo: 'target', baseSha: f.base, summary: 'huge' });
    f.put('8-target', diff('one', 'x'), { repo: 'target', baseSha: 'not-a-sha', summary: 'bad sha' });
    writeFileSync(join(f.root, 'outside.patch'), diff('one', 'x'));
    symlinkSync(join(f.root, 'outside.patch'), join(f.directory, 'patches', '9-target.patch'));
    writeFileSync(join(f.directory, 'patches', '9-target.json'), JSON.stringify({ repo: 'target', baseSha: f.base, summary: 'link' }));
    const patches = await listPatches(f.directory, { helmsman: f.repo, target: f.repo }, GIT);
    expect(patches.map(patch => [patch.file, patch.reason])).toEqual([
      ['4-target.patch', 'invalid sidecar'], ['5-target.patch', 'missing sidecar'], ['6-target.patch', 'invalid sidecar'],
      ['7-target.patch', 'patch too large'], ['8-target.patch', 'invalid sidecar'], ['9-target.patch', 'not a regular file']]);
  });

  it('returns an empty list when no patches directory exists', async () => {
    expect(await listPatches(join(tmpdir(), 'hm-pm-missing-dir'), { helmsman: null, target: null }, GIT)).toEqual([]);
  });
});

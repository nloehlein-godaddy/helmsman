/** @vitest-environment node */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProviderBinary } from './provider-binary';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hm-pm-binary-'))); roots.push(root);
  const home = join(root, 'home'); const temp = join(root, 'T');
  const gocode = join(home, '.gocode', 'shims'); const cmux = join(temp, 'cmux-cli-shims', 'ABC'); const elsewhereCmux = join(root, 'app', 'cmux-cli-shims');
  const real = join(root, 'real'); const decoy = join(root, 'decoy');
  for (const dir of [gocode, cmux, elsewhereCmux, real, decoy]) mkdirSync(dir, { recursive: true });
  for (const dir of [gocode, cmux, elsewhereCmux, real]) for (const name of ['claude', 'codex']) writeFileSync(join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(decoy, 'claude'), 'not executable', { mode: 0o644 }); mkdirSync(join(decoy, 'codex'));
  const resolve = (name: 'claude' | 'codex', env: NodeJS.ProcessEnv) => resolveProviderBinary(name, env, { home });
  return { root, home, temp, gocode, cmux, elsewhereCmux, real, decoy, resolve };
}

describe('post-mortem provider binary', () => {
  it('skips gocode and cmux shims, relative entries and non-executables on PATH', () => {
    const f = fixture();
    const PATH = [f.cmux, f.elsewhereCmux, '', 'relative/bin', f.gocode, f.decoy, f.real].join(':');
    expect(f.resolve('claude', { PATH })).toBe(join(f.real, 'claude'));
    expect(f.resolve('codex', { PATH })).toBe(join(f.real, 'codex'));
  });

  it('skips the gocode shims directory even through a trailing slash or symlinked path', () => {
    const f = fixture();
    expect(f.resolve('claude', { PATH: `${f.gocode}/:${f.real}` })).toBe(join(f.real, 'claude'));
    symlinkSync(f.gocode, join(f.root, 'shims-link'));
    expect(f.resolve('claude', { PATH: `${join(f.root, 'shims-link')}:${f.real}` })).toBe(join(f.real, 'claude'));
  });

  it('prefers GOCODE_REAL_CLAUDE and GOCODE_REAL_CODEX when set', () => {
    const f = fixture();
    const PATH = `${f.gocode}:${f.real}`;
    const override = join(f.root, 'override'); mkdirSync(override); writeFileSync(join(override, 'claude.exe'), '#!/bin/sh\n', { mode: 0o755 });
    expect(f.resolve('claude', { PATH, GOCODE_REAL_CLAUDE: join(override, 'claude.exe') })).toBe(join(override, 'claude.exe'));
    expect(f.resolve('codex', { PATH, GOCODE_REAL_CLAUDE: join(override, 'claude.exe'), GOCODE_REAL_CODEX: join(f.real, 'codex') })).toBe(join(f.real, 'codex'));
  });

  it('rejects an override that is not an absolute executable file', () => {
    const f = fixture();
    expect(() => f.resolve('claude', { PATH: f.real, GOCODE_REAL_CLAUDE: 'claude' })).toThrow(/GOCODE_REAL_CLAUDE/);
    expect(() => f.resolve('claude', { PATH: f.real, GOCODE_REAL_CLAUDE: join(f.decoy, 'claude') })).toThrow(/GOCODE_REAL_CLAUDE/);
  });

  it('fails clearly when only shims are available', () => {
    const f = fixture();
    expect(() => f.resolve('claude', { PATH: [f.gocode, f.cmux].join(':') })).toThrow(/real claude binary.*GOCODE_REAL_CLAUDE/);
    expect(() => f.resolve('codex', {})).toThrow(/real codex binary.*GOCODE_REAL_CODEX/);
  });
});

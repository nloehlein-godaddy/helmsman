/** @vitest-environment node */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { hasShebangShims } from '../../test-support/platform';
import { bashShimPassingLongArgvViaFile } from '../../test-support/argv-shim';
import { preflightSandbox, sandboxCommand, writeSandboxProfile } from './sandbox';

const exec = promisify(execFile);
const cleanups: string[] = [];
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }); });

const OPERATION_NOT_PERMITTED = /Operation not permitted/;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hm-pm-seatbelt-'))); cleanups.push(root);
  const directory = join(root, 'run.postmortem'); const home = join(root, 'home'); const helmsmanRoot = join(root, 'helmsman');
  for (const path of [directory, join(home, '.ssh'), join(home, '.claude'), join(home, '.codex'), helmsmanRoot]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_test'), 'secret'); writeFileSync(join(helmsmanRoot, '.env'), 'TOKEN=1');
  const profile = writeSandboxProfile({ directory, tmpdir: realpathSync(tmpdir()), home, helmsmanRoot });
  const run = (cmd: string, args: string[]) => { const wrapped = sandboxCommand({ cmd, args }, profile); return exec(wrapped.cmd, wrapped.args); };
  return { directory, home, helmsmanRoot, profile, run };
}

function fixtureWithRealHomeOutsideTmpdirAllowance() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hm-pm-seatbelt-'))); cleanups.push(root);
  const directory = join(root, 'run.postmortem'); const helmsmanRoot = join(root, 'helmsman'); const home = realpathSync(homedir());
  mkdirSync(directory, { recursive: true }); mkdirSync(helmsmanRoot, { recursive: true });
  const profile = writeSandboxProfile({ directory, tmpdir: realpathSync(tmpdir()), home, helmsmanRoot });
  const run = (cmd: string, args: string[]) => { const wrapped = sandboxCommand({ cmd, args }, profile); return exec(wrapped.cmd, wrapped.args); };
  return { directory, home, helmsmanRoot, profile, run };
}

function fixtureWithSymlinkedSsh() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hm-pm-seatbelt-'))); cleanups.push(root);
  const directory = join(root, 'run.postmortem'); const home = join(root, 'home'); const helmsmanRoot = join(root, 'helmsman'); const sshReal = join(root, 'ssh-real');
  for (const path of [directory, home, helmsmanRoot, sshReal]) mkdirSync(path, { recursive: true });
  writeFileSync(join(sshReal, 'id_test'), 'secret');
  symlinkSync(sshReal, join(home, '.ssh'));
  const profile = writeSandboxProfile({ directory, tmpdir: realpathSync(tmpdir()), home, helmsmanRoot });
  const run = (cmd: string, args: string[]) => { const wrapped = sandboxCommand({ cmd, args }, profile); return exec(wrapped.cmd, wrapped.args); };
  return { directory, home, helmsmanRoot, sshReal, profile, run };
}

describe.skipIf(process.platform !== 'darwin' || !hasShebangShims)('post-mortem Seatbelt profile', () => {
  it('passes preflight', async () => { await expect(preflightSandbox(fixture().profile)).resolves.toBeUndefined(); });

  it('confines writes to the allowlist', async () => {
    const f = fixture(); const outside = join(homedir(), `.helmsman-pm-probe-${randomUUID()}`); cleanups.push(outside);
    await f.run('/bin/sh', ['-c', `echo ok > '${join(f.directory, 'inside.txt')}'`]);
    expect(readFileSync(join(f.directory, 'inside.txt'), 'utf8')).toBe('ok\n');
    await expect(f.run('/bin/sh', ['-c', `echo no > '${outside}'`])).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it('denies writes under the provider config dirs (no persistence escape via ~/.claude or ~/.codex)', async () => {
    const f = fixtureWithRealHomeOutsideTmpdirAllowance();
    mkdirSync(join(f.home, '.claude'), { recursive: true }); mkdirSync(join(f.home, '.codex'), { recursive: true });
    const claudeTarget = join(f.home, '.claude', `helmsman-pm-probe-${randomUUID()}.json`); cleanups.push(claudeTarget);
    const codexTarget = join(f.home, '.codex', `helmsman-pm-probe-${randomUUID()}.json`); cleanups.push(codexTarget);
    await expect(f.run('/bin/sh', ['-c', `echo no > '${claudeTarget}'`])).rejects.toThrow();
    await expect(f.run('/bin/sh', ['-c', `echo no > '${codexTarget}'`])).rejects.toThrow();
    expect(existsSync(claudeTarget)).toBe(false);
    expect(existsSync(codexTarget)).toBe(false);
  });

  it('denies credential and helmsman .env reads', async () => {
    const f = fixture();
    await expect(f.run('/bin/cat', [join(f.home, '.ssh', 'id_test')])).rejects.toThrow(OPERATION_NOT_PERMITTED);
    await expect(f.run('/bin/cat', [join(f.helmsmanRoot, '.env')])).rejects.toThrow(OPERATION_NOT_PERMITTED);
  });

  it('denies reads of a symlinked ~/.ssh via its real target path too', async () => {
    const f = fixtureWithSymlinkedSsh();
    await expect(f.run('/bin/cat', [join(f.home, '.ssh', 'id_test')])).rejects.toThrow(OPERATION_NOT_PERMITTED);
    await expect(f.run('/bin/cat', [join(f.sshReal, 'id_test')])).rejects.toThrow(OPERATION_NOT_PERMITTED);
  });

  it('runs a node fake behind a bash shim with a long argument', async () => {
    const f = fixture();
    const script = join(f.directory, 'fake.cjs');
    writeFileSync(script, `const fs = require('node:fs'); const args = fs.readFileSync(process.env.TEST_ARGS_FILE, 'utf8').split('\\0').filter(Boolean);
      fs.writeFileSync(${JSON.stringify(join(f.directory, 'length.txt'))}, String(args[0].length));`);
    const shim = join(f.directory, 'fake'); writeFileSync(shim, bashShimPassingLongArgvViaFile(script), { mode: 0o755 });
    await exec('/usr/bin/sandbox-exec', ['-f', f.profile, shim, 'y'.repeat(5000)]);
    expect(readFileSync(join(f.directory, 'length.txt'), 'utf8')).toBe('5000');
  });
});

/** @vitest-environment node */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightSandbox, resolveSandboxPaths, sandboxCommand, sandboxProfile, sandboxProfilePath, scrubEnvironment, seatbeltString, writeSandboxProfile, SandboxUnavailableError } from './sandbox';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('post-mortem sandbox', () => {
  it('emits the spec profile with allow and deny lists, without granting write access to provider config dirs', () => {
    expect(sandboxProfile({ directory: '/r/run.postmortem', tmpdir: '/private/var/T', home: '/Users/me', helmsmanRoot: '/src/helmsman' })).toBe([
      '(version 1)', '(allow default)', '(deny file-write*)',
      '(allow file-write* (subpath "/r/run.postmortem") (subpath "/private/var/T") (subpath "/dev"))',
      '(deny file-read* (subpath "/Users/me/.ssh") (subpath "/Users/me/.config/gh") (literal "/Users/me/.netrc")',
      '                 (subpath "/Users/me/.aws") (regex "^/src/helmsman/\\\\.env"))', '',
    ].join('\n'));
  });

  it('escapes and realpaths every path', () => {
    expect(seatbeltString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
    expect(sandboxProfile({ directory: '/x', tmpdir: '/t', home: '/h', helmsmanRoot: '/src/my.app (1)' })).toContain('(regex "^/src/my\\\\.app \\\\(1\\\\)/\\\\.env")');
    const root = mkdtempSync(join(tmpdir(), 'hm-pm-sandbox-')); roots.push(root);
    const target = join(root, 'real'); mkdirSync(target); symlinkSync(target, join(root, 'link'));
    const paths = resolveSandboxPaths(join(root, 'link'), join(root, 'link'));
    expect(paths).toMatchObject({ directory: realpathSync(target), helmsmanRoot: realpathSync(target), tmpdir: realpathSync(tmpdir()) });
  });

  it('scrubs credentials but keeps model routing and disables git credentials', () => {
    const env = scrubEnvironment({ PATH: '/bin', TMPDIR: '/t', GITHUB_TOKEN: 'g', GH_TOKEN: 'h', JIRA_API_TOKEN: 'j', JIRA_EMAIL: 'e', SLACK_OI_TOKEN_FILE: 's',
      NPM_TOKEN: 'n', CLIENT_SECRET: 'c', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'x', HELMSMAN_MODEL_CAPABILITY: 'cap', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'u',
      ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'at', ANTHROPIC_BASE_URL: 'ab', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/cc',
      AWS_SECRET_ACCESS_KEY: 'sk', AWS_ACCESS_KEY_ID: 'ak', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: '/bin/askpass',
      VSCODE_GIT_IPC_HANDLE: '/tmp/vsc.sock', github_token: 'lower' });
    expect(env).toEqual({ PATH: '/bin', TMPDIR: '/t', HELMSMAN_MODEL_CAPABILITY: 'cap', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'u', ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_AUTH_TOKEN: 'at', ANTHROPIC_BASE_URL: 'ab', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/cc',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' });
  });

  it('writes the profile next to, never inside, the agent-writable directory, replacing a pre-existing symlink without following it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-pm-sandbox-')); roots.push(root);
    const directory = join(root, 'run.postmortem'); mkdirSync(directory);
    const paths = resolveSandboxPaths(directory, directory);
    const profilePath = sandboxProfilePath(paths.directory);
    expect(profilePath.startsWith(`${paths.directory}/`)).toBe(false);
    const decoyTarget = join(root, 'evil-target'); writeFileSync(decoyTarget, 'untouched');
    symlinkSync(decoyTarget, profilePath);
    const written = writeSandboxProfile(paths);
    expect(written).toBe(profilePath);
    expect(readFileSync(decoyTarget, 'utf8')).toBe('untouched');
    expect(readFileSync(written, 'utf8')).toBe(sandboxProfile(paths));
  });

  it('wraps commands natively and refuses oversized argv elements', () => {
    expect(sandboxCommand({ cmd: 'codex', args: ['app-server'] }, '/p/profile.sb')).toEqual({ cmd: '/usr/bin/sandbox-exec', args: ['-f', '/p/profile.sb', 'codex', 'app-server'] });
    expect(() => sandboxCommand({ cmd: 'codex', args: ['x'.repeat(1025)] }, '/p')).toThrow('exceeds 1024 bytes');
  });

  it('refuses to run off macOS', async () => {
    await expect(preflightSandbox('/p/profile.sb', 'linux')).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

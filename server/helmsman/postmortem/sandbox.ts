import { execFile } from 'node:child_process';
import { readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export class SandboxUnavailableError extends Error {}
export interface SandboxPaths { directory: string; tmpdir: string; home: string; helmsmanRoot: string }
export const SANDBOX_ARGUMENT_LIMIT = 1024;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const ROUTING_VARIABLES = new Set(['HELMSMAN_MODEL_CAPABILITY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
const CREDENTIAL_VARIABLE = /^(?:JIRA_.*|SLACK_.*|GIT_CONFIG_.*|SSH_AUTH_SOCK|.*ASKPASS|VSCODE_GIT_.*)$|(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)(?:_|$)/i;

export function seatbeltString(value: string): string {
  return `"${value.replace(/[\\"]/g, match => `\\${match}`)}"`;
}

const regexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tryRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function denyTerm(kind: 'subpath' | 'literal', path: string): string {
  const real = tryRealpath(path);
  const extra = real && real !== path ? ` (${kind} ${seatbeltString(real)})` : '';
  return `(${kind} ${seatbeltString(path)})${extra}`;
}

function denyEnvSymlinkTerms(helmsmanRoot: string): string {
  let entries: string[];
  try { entries = readdirSync(helmsmanRoot); } catch { return ''; }
  const terms = entries.filter(entry => entry.startsWith('.env')).flatMap(entry => {
    const path = join(helmsmanRoot, entry);
    const real = tryRealpath(path);
    return real && real !== path ? [`(literal ${seatbeltString(real)})`] : [];
  });
  return terms.length ? ` ${terms.join(' ')}` : '';
}

export function resolveSandboxPaths(directory: string, helmsmanRoot: string): SandboxPaths {
  return { directory: realpathSync(directory), tmpdir: realpathSync(tmpdir()), home: realpathSync(homedir()), helmsmanRoot: realpathSync(helmsmanRoot) };
}

export function sandboxProfile(paths: SandboxPaths): string {
  const sshTerm = denyTerm('subpath', join(paths.home, '.ssh'));
  const ghTerm = denyTerm('subpath', join(paths.home, '.config/gh'));
  const netrcTerm = denyTerm('literal', join(paths.home, '.netrc'));
  const awsTerm = denyTerm('subpath', join(paths.home, '.aws'));
  const envTerm = `(regex ${seatbeltString(`^${regexLiteral(paths.helmsmanRoot)}/\\.env`)})${denyEnvSymlinkTerms(paths.helmsmanRoot)}`;
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* (subpath ${seatbeltString(paths.directory)}) (subpath ${seatbeltString(paths.tmpdir)}) (subpath "/dev"))`,
    `(deny file-read* ${sshTerm} ${ghTerm} ${netrcTerm}`,
    `                 ${awsTerm} ${envTerm})`, ''].join('\n');
}

export function sandboxProfilePath(directory: string): string {
  return `${directory}.sb`;
}

/**
 * Writes the Seatbelt profile as a sibling of the agent-writable directory, never inside it,
 * so the sandboxed agent can neither read nor replace its own profile. Any pre-existing file
 * or symlink at that path is removed first (the removal itself cannot be redirected by a
 * symlink there, since it unlinks the path entry rather than following it), then the file is
 * created with `wx` so a race recreating a dangling symlink after the removal still fails
 * closed instead of writing through it. Call this again immediately before every
 * `preflightSandbox`, since the profile must always reflect the current paths and must never
 * be reused from a previous turn.
 */
export function writeSandboxProfile(paths: SandboxPaths): string {
  const path = sandboxProfilePath(paths.directory);
  rmSync(path, { force: true });
  writeFileSync(path, sandboxProfile(paths), { mode: 0o600, flag: 'wx' });
  return path;
}

export function scrubEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'
    && (ROUTING_VARIABLES.has(entry[0]) || !CREDENTIAL_VARIABLE.test(entry[0])));
  return { ...Object.fromEntries(kept), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' };
}

export function sandboxCommand(command: { cmd: string; args: readonly string[] }, profilePath: string): { cmd: string; args: string[] } {
  if ([command.cmd, ...command.args].some(argument => Buffer.byteLength(argument) > SANDBOX_ARGUMENT_LIMIT)) throw new Error(`Post-mortem argv element exceeds ${SANDBOX_ARGUMENT_LIMIT} bytes`);
  return { cmd: SANDBOX_EXEC, args: ['-f', profilePath, command.cmd, ...command.args] };
}

export async function preflightSandbox(profilePath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'darwin') throw new SandboxUnavailableError('Post-mortem sandbox requires macOS');
  await new Promise<void>((resolve, reject) => execFile(SANDBOX_EXEC, ['-f', profilePath, '/usr/bin/true'], { timeout: 10_000 },
    error => error ? reject(new SandboxUnavailableError(`Sandbox preflight failed: ${error.message}`)) : resolve()));
}

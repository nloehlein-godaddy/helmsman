import { execFile } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export class SandboxUnavailableError extends Error {}
export interface SandboxPaths { directory: string; tmpdir: string; home: string; helmsmanRoot: string }
export const SANDBOX_ARGUMENT_LIMIT = 1024;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const ROUTING_VARIABLES = new Set(['HELMSMAN_MODEL_CAPABILITY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
const CREDENTIAL_VARIABLE = /^(?:GITHUB_TOKEN|GH_TOKEN|JIRA_.*|SLACK_.*|GIT_CONFIG_.*|.*_TOKEN|.*_SECRET)$/;

export function seatbeltString(value: string): string {
  return `"${value.replace(/[\\"]/g, match => `\\${match}`)}"`;
}

const regexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveSandboxPaths(directory: string, helmsmanRoot: string): SandboxPaths {
  return { directory: realpathSync(directory), tmpdir: realpathSync(tmpdir()), home: realpathSync(homedir()), helmsmanRoot: realpathSync(helmsmanRoot) };
}

export function sandboxProfile(paths: SandboxPaths): string {
  const home = (suffix: string) => seatbeltString(`${paths.home}/${suffix}`);
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* (subpath ${seatbeltString(paths.directory)}) (subpath ${seatbeltString(paths.tmpdir)}) (subpath "/dev")`,
    `                   (subpath ${home('.codex')}) (subpath ${home('.claude')}))`,
    `(deny file-read* (subpath ${home('.ssh')}) (subpath ${home('.config/gh')}) (literal ${home('.netrc')})`,
    `                 (subpath ${home('.aws')}) (regex ${seatbeltString(`^${regexLiteral(paths.helmsmanRoot)}/\\.env`)}))`, ''].join('\n');
}

export function writeSandboxProfile(paths: SandboxPaths): string {
  const path = join(paths.directory, 'profile.sb');
  writeFileSync(path, sandboxProfile(paths), { mode: 0o600 });
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

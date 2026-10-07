import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

export type ProviderBinary = 'claude' | 'codex';
const OVERRIDE: Record<ProviderBinary, string> = { claude: 'GOCODE_REAL_CLAUDE', codex: 'GOCODE_REAL_CODEX' };

const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

function shimDirectory(entry: string, gocodeShims: readonly string[]): boolean {
  return [resolve(entry), canonical(entry)].some(path => gocodeShims.includes(path) || path.split(sep).includes('cmux-cli-shims'));
}

/**
 * Finds the real provider executable for a post-mortem, bypassing wrapper shims that would
 * mutate state under the real HOME (`~/.gocode/shims` takes a settings lock there) or live in
 * a `cmux-cli-shims` directory (normally under the global `$TMPDIR`). Helmsman's scoped gateway already provides
 * the model routing those wrappers exist for. `GOCODE_REAL_CLAUDE` / `GOCODE_REAL_CODEX` win
 * when set; otherwise `PATH` is searched with the shim directories skipped.
 */
export function resolveProviderBinary(name: ProviderBinary, env: NodeJS.ProcessEnv, options: { home?: string } = {}): string {
  const variable = OVERRIDE[name];
  const override = env[variable]?.trim();
  if (override) {
    if (!isAbsolute(override) || !executable(override)) throw new Error(`${variable} must be the absolute path of an executable ${name} binary.`);
    return override;
  }
  const gocode = join(options.home ?? homedir(), '.gocode', 'shims');
  const shims = [resolve(gocode), canonical(gocode)];
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry) || shimDirectory(entry, shims)) continue;
    const candidate = join(entry, name);
    if (executable(candidate)) return candidate;
  }
  throw new Error(`Could not find the real ${name} binary for the post-mortem (gocode and cmux shims are skipped). Set ${variable} to its absolute path.`);
}

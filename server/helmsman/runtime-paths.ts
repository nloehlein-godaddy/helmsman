import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function applicationRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export function runtimeModulePath(relative: string, moduleUrl: string): string {
  const path = new URL(moduleUrl).pathname.endsWith('.js') ? relative.replace(/\.ts$/, '.js') : relative;
  return fileURLToPath(new URL(path, moduleUrl));
}

export function runtimeNodeArguments(relative: string, moduleUrl: string): string[] {
  const entry = runtimeModulePath(relative, moduleUrl);
  return entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), entry] : [entry];
}

export function isHostCoordinatorCommand(command: { cmd: string; args: readonly string[] }): boolean {
  return [command.cmd, ...command.args].some(path => /(?:^|[\\/])(?:pre-pr-cli|docker-review-cli|feedback-update-cli)\.[jt]s$/.test(path));
}

/**
 * Long individual script arguments can be killed before Node starts on macOS.
 * The `--input=` prefix keeps retained hosts from remapping payload fragments as runtime paths.
 */
export function chunkInputArguments(value: string): string[] {
  const chunks: string[] = [];
  let chunk = '--input=';
  for (const character of value) {
    if (chunk.length + character.length > 256) { chunks.push(chunk); chunk = '--input='; }
    chunk += character;
  }
  chunks.push(chunk);
  return chunks;
}

export function joinInputArguments(argv: readonly string[]): string {
  return argv.map(argument => argument.startsWith('--input=') ? argument.slice('--input='.length) : argument).join('');
}

export function retainedRuntimePath(value: string, originalRoot: string, retainedRoot: string): string {
  const url = value.startsWith('file:');
  let path: string;
  try { path = url ? fileURLToPath(value) : value; } catch { return value; }
  if (!isAbsolute(path)) return value;
  path = resolve(path);
  const root = resolve(originalRoot);
  const roots = [join(root, 'server', 'helmsman'), join(root, 'node_modules')];
  if (!roots.some(directory => path.startsWith(`${directory}${sep}`))) return value;
  const retained = join(retainedRoot, relative(root, path));
  return url ? pathToFileURL(retained).href : retained;
}

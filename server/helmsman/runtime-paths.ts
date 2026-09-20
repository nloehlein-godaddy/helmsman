import { fileURLToPath } from 'node:url';

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

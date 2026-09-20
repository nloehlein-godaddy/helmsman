// @vitest-environment node
import { expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { applicationRoot, isHostCoordinatorCommand, runtimeModulePath, runtimeNodeArguments } from './runtime-paths';

it('resolves application assets independently of the working directory', () => {
  expect(applicationRoot()).toBe(fileURLToPath(new URL('../../', import.meta.url)));
});

it('selects compiled helpers beside their calling module without loading tsx', () => {
  const moduleUrl = pathToFileURL(join(applicationRoot(), 'release', 'server', 'helmsman', 'agents', 'pre-pr.js')).href;
  const entry = join(applicationRoot(), 'release', 'server', 'helmsman', 'pre-pr-cli.js');
  expect(runtimeModulePath('../pre-pr-cli.ts', moduleUrl)).toBe(entry);
  expect(runtimeNodeArguments('../pre-pr-cli.ts', moduleUrl)).toEqual([entry]);
  expect(runtimeModulePath('../run-wrapper.mjs', moduleUrl)).toBe(join(applicationRoot(), 'release', 'server', 'helmsman', 'run-wrapper.mjs'));
});

it('retains TypeScript helper execution for development', () => {
  const args = runtimeNodeArguments('./pre-pr-cli.ts', import.meta.url);
  expect(args[0]).toBe('--import');
  expect(args[1]).toContain('tsx');
  expect(args[2]).toBe(fileURLToPath(new URL('./pre-pr-cli.ts', import.meta.url)));
});

it.each(['pre-pr-cli', 'docker-review-cli'].flatMap(name => ['ts', 'js'].flatMap(extension => [
  `/app/server/helmsman/${name}.${extension}`, `C:\\app\\server\\helmsman\\${name}.${extension}`,
  `${name}.${extension}`,
])))('routes host coordinator %s locally for source and compiled installations', path => {
  expect(isHostCoordinatorCommand({ cmd: 'node', args: [path, '{}'] })).toBe(true);
  expect(isHostCoordinatorCommand({ cmd: path, args: [] })).toBe(true);
});

it.each(['/app/worker.js', 'C:\\app\\worker.ts', '/app/pre-pr-cli.js.map', '/app/not-pre-pr-cli.js',
  '/app/docker-review-cli.ts/child.js', '/app/run-wrapper.mjs'])('leaves ordinary worker %s on its selected host', path => {
  expect(isHostCoordinatorCommand({ cmd: 'node', args: [path] })).toBe(false);
});

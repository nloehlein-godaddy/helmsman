// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parsePluginPackage } from '../../../src/plugins/package';
import { initializeCommunicationProviderDefault, initializePullRequestProviderDefault, openPluginData, pluginJson, readCommunicationProviderBinding, readPullRequestProviderBinding, selectCommunicationProvider, selectPullRequestProvider, writePluginSettings } from './data';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'helmsman-plugin-data-')); roots.push(root); return root; }
const pkg = parsePluginPackage({ packageVersion: 1, manifest: { manifestVersion: 1, id: 'example.data', version: '1.0.0', sdkVersion: 1, pages: [] },
  entries: {}, node: { minMajor: 1, maxMajorExclusive: 1000 }, backend: { entry: 'backend.js', provides: [], storageVersion: 1,
    settings: { enabled: { type: 'boolean', default: true }, title: { type: 'string', default: 'title', maxLength: 10 } } } });

it('rejects getters, non-JSON values, cycles, and oversized persisted data without evaluating accessors', () => {
  const getter = vi.fn(() => 1);
  const input = Object.defineProperty({}, 'secret', { get: getter });
  expect(() => pluginJson(input)).toThrow('accessors');
  expect(getter).not.toHaveBeenCalled();
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [cyclic, undefined, NaN, Infinity, () => {}, new Date(), new Array(2), 'x'.repeat(128 * 1024)]) {
    expect(() => pluginJson(value)).toThrow();
  }
});

it('bounds keys and atomically rolls back quota violations', async () => {
  const root = await temporary();
  const data = openPluginData(root, pkg);
  try {
    data.commit(new Map([['original', 1]]));
    for (const key of ['', '../escape', 'a/b', 'x'.repeat(129)]) expect(() => data.read(key)).toThrow('key');
    expect(() => data.commit(new Map(Array.from({ length: 1024 }, (_, i) => [`key-${i}`, i])))).toThrow('quota');
    expect(data.read('original')).toBe(1);
    expect(data.read('key-0')).toBeUndefined();
  } finally { data.close(); }
});

it('enforces aggregate storage quota by UTF-8 bytes rather than Unicode characters', async () => {
  const root = await temporary();
  const data = openPluginData(root, pkg);
  try {
    data.commit(new Map([['original', 1]]));
    const value = '😀'.repeat(20_000);
    expect(() => data.commit(new Map(Array.from({ length: 106 }, (_, i) => [`unicode-${i}`, value])))).toThrow('quota');
    expect(data.read('original')).toBe(1);
    expect(data.read('unicode-0')).toBeUndefined();
  } finally { data.close(); }
});

it('rejects incompatible storage versions and invalid settings without changing stored values', async () => {
  const root = await temporary();
  expect(writePluginSettings(root, pkg, { enabled: false })).toEqual({ enabled: false, title: 'title' });
  expect(() => writePluginSettings(root, pkg, { enabled: true, title: 'too many characters' })).toThrow('schema');
  expect(writePluginSettings(root, pkg, {})).toEqual({ enabled: false, title: 'title' });
  const sql = new Database(join(root, 'plugin-data.sqlite'));
  sql.prepare('INSERT INTO plugin_storage_versions VALUES(?,?)').run(pkg.manifest.id, 2); sql.close();
  expect(() => openPluginData(root, pkg)).toThrow('version');
});

it('retains an explicit pull request provider selection without silently replacing it', async () => {
  const root = await temporary();
  initializePullRequestProviderDefault(root, 'example.github/github');
  expect(readPullRequestProviderBinding(root)).toBe('example.github/github');
  selectPullRequestProvider(root, 'example.alternative/reviews');
  initializePullRequestProviderDefault(root, 'example.github/github');
  expect(readPullRequestProviderBinding(root)).toBe('example.alternative/reviews');
  selectPullRequestProvider(root, null);
  expect(readPullRequestProviderBinding(root)).toBeUndefined();
  initializeCommunicationProviderDefault(root, 'example.slack/slack');
  expect(readCommunicationProviderBinding(root)).toBe('example.slack/slack');
  selectCommunicationProvider(root, 'example.alternative/chat');
  expect(readCommunicationProviderBinding(root)).toBe('example.alternative/chat');
  selectCommunicationProvider(root, null);
  expect(readCommunicationProviderBinding(root)).toBeUndefined();
});

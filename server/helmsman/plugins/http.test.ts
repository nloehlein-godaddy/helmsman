// @vitest-environment node
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COSTS_PAGE_SLOT } from '../../../src/plugins/builtins';
import { parsePluginArchive } from './artifacts';
import { handlePluginRequest } from './http';
import { installPlugin, loadPluginSnapshot, setPluginEnabled } from './store';
import type { PluginSnapshot } from './store';

const source = 'export default { mount() { return { update() {}, dispose() {} }; } };';
const nodeMajor = Number(process.versions.node.split('.')[0]);
function archiveBytes() {
  return Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
    package: { packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'example.http', version: '1.0.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'HTTP example', slots: [COSTS_PAGE_SLOT], panes: [] }] },
      node: { minMajor: nodeMajor, maxMajorExclusive: nodeMajor + 2 }, entries: { page: 'dist/page.js' } },
    files: [
      { path: 'dist/page.js', base64: Buffer.from(source).toString('base64') },
      { path: 'styles/page.css', base64: Buffer.from('.example { color: red; }').toString('base64') },
    ],
  }));
}
const artifact = parsePluginArchive(archiveBytes());
const prefix = `/plugin-assets/example.http/${artifact.hash}`;
const snapshot = (): PluginSnapshot => ({
  catalog: { version: 1, safeMode: false, plugins: [{ package: artifact.package, hash: artifact.hash }], bindings: {} },
  artifacts: new Map([[`example.http/${artifact.hash}`, artifact]]), errors: [],
});

function request(path: string, method = 'GET', state = snapshot()) {
  const headers = new Map<string, string>();
  let status: number | undefined;
  let body: unknown;
  let ended = false;
  const req = { method, url: path } as IncomingMessage;
  const res = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); return this; },
    writeHead(code: number, values: Record<string, string>) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value);
      return this;
    },
    end(value?: unknown) { body = value; ended = true; return this; },
  } as unknown as ServerResponse;
  const handled = handlePluginRequest(req, res, new URL(path, 'http://localhost'), state);
  return { handled, status, headers, body, ended };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-plugin-http-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('plugin HTTP routes', () => {
  it('serves immutable package bytes with their content type and nosniff', () => {
    const response = request(`${prefix}/dist/page.js`);
    expect(response.handled).toBe(true);
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body as Uint8Array).toString()).toBe(source);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.ended).toBe(true);
    expect(request(`${prefix}/styles/page.css`).headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('returns the catalog without caching it or exposing package bytes', () => {
    const state = snapshot();
    state.catalog.bindings[COSTS_PAGE_SLOT] = 'example.http/page';
    const response = request('/api/plugins/catalog', 'GET', state);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(response.body as string)).toEqual(state.catalog);
    expect(response.body).not.toContain(source);
  });

  it.each(['/api/plugins/catalog', `${prefix}/dist/page.js`])('supports HEAD without a response body for %s', path => {
    const response = request(path, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
    expect(response.ended).toBe(true);
  });

  it.each(['/api/plugins/catalog', `${prefix}/dist/page.js`, '/plugin-assets'])('rejects mutation methods for %s', path => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = request(path, method);
      expect(response.handled).toBe(true);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it.each([
    '/plugin-assets', '/plugin-assets/', '/plugin-assets/not-a-package', `${prefix}/missing.js`,
    `${prefix}/dist/page.js/extra`, `${prefix}/dist//page.js`, `${prefix}/dist/%70age.js`,
    `${prefix}/dist%2fpage.js`, `${prefix}/dist%5cpage.js`, `${prefix}/%00page.js`,
    `/plugin-assets/example.http/${'b'.repeat(64)}/dist/page.js`,
    `/plugin-assets/example.other/${artifact.hash}/dist/page.js`,
    `/plugin-assets/example.http/${artifact.hash.toUpperCase()}/dist/page.js`,
  ])('rejects unknown or encoded asset paths without falling back to the SPA: %s', path => {
    const response = request(path);
    expect(response.handled).toBe(true);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).toBe('Plugin asset not found.');
  });

  it.each([
    '/plugin-assets/../../outcomes', '/plugin-assets/%2e%2e/%2e%2e/outcomes',
    'http://localhost/plugin-assets/../../outcomes', '/plugin-assets\\..\\outcomes',
    `${prefix}/dist/../dist/page.js`, `${prefix}/dist/%2e%2e/dist/page.js`,
    `${prefix}/dist\\page.js`,
  ])('rejects raw traversal before URL normalization can serve a page: %s', path => {
    const response = request(path);
    expect(response.handled).toBe(true);
    expect(response.status).toBe(404);
  });

  it.each(['/outcomes', '/plugins/example.http/page', '/api/context', '/assets/main.js', '/plugin-assets-other'])('leaves unrelated route %s to the host', path => {
    const response = request(path);
    expect(response.handled).toBe(false);
    expect(response.status).toBeUndefined();
    expect(response.ended).toBe(false);
  });

  it('serves only enabled snapshot artifacts and keeps an existing snapshot stable across store changes', async () => {
    const installed = await installPlugin(root, archiveBytes());
    const disabled = await loadPluginSnapshot(root);
    expect(request(`${prefix}/dist/page.js`, 'GET', disabled).status).toBe(404);
    expect(JSON.parse(request('/api/plugins/catalog', 'GET', disabled).body as string).plugins).toEqual([]);
    await setPluginEnabled(root, installed.id, true);
    const enabled = await loadPluginSnapshot(root);
    expect(request(`${prefix}/dist/page.js`, 'GET', enabled).status).toBe(200);
    await setPluginEnabled(root, installed.id, false);
    expect(request(`${prefix}/dist/page.js`, 'GET', enabled).status).toBe(200);
    expect(request(`${prefix}/dist/page.js`, 'GET', await loadPluginSnapshot(root)).status).toBe(404);
  });

  it('exposes safe mode through an uncached empty catalog and serves no plugin assets', async () => {
    const installed = await installPlugin(root, archiveBytes());
    await setPluginEnabled(root, installed.id, true);
    const safe = await loadPluginSnapshot(root, true);
    expect(JSON.parse(request('/api/plugins/catalog', 'GET', safe).body as string)).toMatchObject({ safeMode: true, plugins: [] });
    expect(request(`${prefix}/dist/page.js`, 'GET', safe).status).toBe(404);
  });
});

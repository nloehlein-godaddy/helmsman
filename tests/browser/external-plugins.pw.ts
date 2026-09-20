import { expect, test } from '@playwright/test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COSTS_PAGE_SLOT } from '../../src/plugins/builtins';
import { packPluginDirectory } from '../../server/helmsman/plugins/artifacts';
import { handlePluginRequest } from '../../server/helmsman/plugins/http';
import { installPlugin, loadPluginSnapshot, selectPluginPage, setPluginEnabled } from '../../server/helmsman/plugins/store';

const pluginId = 'example.scope-summary';
const contribution = `${pluginId}/page`;
const canonicalPath = `/plugins/${contribution}`;

async function harness(safeMode = false) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-browser-plugin-'));
  const source = join(directory, 'external-project');
  const registry = join(directory, 'registry');
  const requests: string[] = [];
  const errors: string[] = [];
  try {
    await cp(fileURLToPath(new URL('../../examples/plugins/scope-summary', import.meta.url)), source, { recursive: true });
    const archive = await packPluginDirectory(source);
    await installPlugin(registry, archive.bytes);
    await setPluginEnabled(registry, pluginId, true);
    await selectPluginPage(registry, COSTS_PAGE_SLOT, contribution);
    let snapshot = await loadPluginSnapshot(registry, safeMode);
    expect(snapshot.errors).toEqual([]);
    async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      if (handlePluginRequest(req, res, url, snapshot)) return;
      if (url.pathname.startsWith('/api/')) {
        let body: unknown = {};
        if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true };
        if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
        if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
        if (url.pathname === '/api/runs') body = { runs: [], total: 0, limit: 25, offset: 0 };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      const path = url.pathname.startsWith('/plugins/') ? '/index.html' : `${url.pathname}${url.search}`;
      const response = await fetch(`http://127.0.0.1:4175${path}`, { signal: AbortSignal.timeout(10_000) });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(Buffer.from(await response.arrayBuffer()));
    }
    const server = createServer((req, res) => {
      void respond(req, res).catch(error => {
        errors.push(error instanceof Error ? error.message : String(error));
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Browser plugin harness failed.');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Browser plugin harness has no TCP address.');
    return {
      origin: `http://127.0.0.1:${address.port}`, archive, requests, errors,
      async enabled(enabled: boolean): Promise<void> {
        await setPluginEnabled(registry, pluginId, enabled);
        snapshot = await loadPluginSnapshot(registry, safeMode);
        expect(snapshot.errors).toEqual([]);
      },
      async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('an installed external archive loads through production HTTP and survives scope, disable, and re-enable', async ({ page, request }) => {
  const host = await harness();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    const catalog = await request.get(`${host.origin}/api/plugins/catalog`);
    expect(catalog.status()).toBe(200);
    expect(catalog.headers()['cache-control']).toBe('no-store');
    expect(await catalog.json()).toMatchObject({ bindings: { [COSTS_PAGE_SLOT]: contribution },
      plugins: [{ hash: host.archive.hash, package: { manifest: { id: pluginId } } }] });
    const entry = host.archive.package.entries.page;
    const assetPath = `/plugin-assets/${pluginId}/${host.archive.hash}/${entry}`;
    const asset = await request.get(`${host.origin}${assetPath}`);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers()['content-type']).toMatch(/javascript/);
    expect(asset.headers()['x-content-type-options']).toBe('nosniff');
    expect(await asset.body()).toEqual(Buffer.from(host.archive.files.get(entry ?? '') ?? []));
    const missing = await request.get(`${host.origin}/plugin-assets/${pluginId}/${host.archive.hash}/missing.js`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).not.toContain('<html');

    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === assetPath && response.status() === 200);
    await page.goto(`${host.origin}${canonicalPath}?repo=org/a`);
    await loaded;
    await expect(page.getByRole('heading', { name: 'External scope summary' })).toBeVisible();
    await expect(page.locator('[data-sample-scope]')).toHaveText('org/a');
    await page.locator('.repo-select').selectOption('org/b');
    await expect(page.locator('[data-sample-scope]')).toHaveText('org/b');
    await expect(page).toHaveURL(url => url.pathname === canonicalPath && url.searchParams.get('repo') === 'org/b');
    const pirate = page.getByRole('button', { name: 'Pirate mode', exact: true });
    const wasPirate = await pirate.getAttribute('aria-pressed') === 'true';
    await pirate.click();
    await expect(page.getByText(wasPirate ? 'Current repository' : 'Current galleon', { exact: true })).toBeVisible();
    await expect(page.locator('[data-sample-scope]')).toHaveText('org/b');
    await page.reload();
    await expect(page.locator('[data-sample-scope]')).toHaveText('org/b');
    await page.getByRole('button', { name: 'Open runs' }).click();
    await expect(page).toHaveURL(url => url.pathname === '/runs' && url.searchParams.get('repo') === 'org/b');
    await page.goto(`${host.origin}/outcomes?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'External scope summary' })).toBeVisible();
    await expect(page.locator('[data-sample-scope]')).toHaveText('org/a');
    expect(host.requests).not.toContain('/api/outcomes');

    await host.enabled(false);
    const requestBoundary = host.requests.length;
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
    const disabledCatalog = await request.get(`${host.origin}/api/plugins/catalog`);
    expect(await disabledCatalog.json()).toMatchObject({ plugins: [], bindings: { [COSTS_PAGE_SLOT]: contribution } });
    expect(host.requests.slice(requestBoundary).filter(path => path.startsWith('/plugin-assets/'))).toEqual([]);
    expect(host.requests).not.toContain('/api/outcomes');

    await host.enabled(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'External scope summary' })).toBeVisible();
    await expect(page.locator('[data-sample-scope]')).toHaveText('org/a');
    expect(host.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await host.close(); }
});

test('safe mode leaves external and builtin Costs pages unavailable without fetching their data or assets', async ({ page }) => {
  const host = await harness(true);
  try {
    for (const path of [canonicalPath, '/outcomes', '/plugins/helmsman.costs/page']) {
      await page.goto(`${host.origin}${path}?repo=org/a`);
      await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'External scope summary' })).toHaveCount(0);
      await expect(page.locator('section.outcomes-view')).toHaveCount(0);
    }
    expect(host.requests.filter(path => path.startsWith('/plugin-assets/'))).toEqual([]);
    expect(host.requests).not.toContain('/api/outcomes');
    expect(host.errors).toEqual([]);
  } finally { await host.close(); }
});

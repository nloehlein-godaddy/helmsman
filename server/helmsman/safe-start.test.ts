// @vitest-environment node
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtinPageSlots, COSTS_PAGE_SLOT } from '../../src/plugins/page-slots';
import { createSafeStartServer, safeStartEnabled } from './safe-start';

let root: string;
let dbPath: string;
let pluginsDir: string;
let dist: string;
let server: Server | undefined;
let base: string;
const hash = 'a'.repeat(64);

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-safe-start-'));
  dbPath = join(root, 'state.sqlite');
  pluginsDir = join(root, 'plugins');
  dist = join(root, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Stored application</title>');
});
afterEach(async () => {
  if (server) {
    const current = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

async function start(env: Record<string, string> = {}) {
  server = createSafeStartServer({ dbPath, pluginsDir, dist, env });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  base = `http://127.0.0.1:${address.port}`;
}

async function seed() {
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE TABLE runs (id TEXT, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT, attempt INTEGER,
      prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT, hostKind TEXT,
      hostRef TEXT, logPath TEXT, exitPath TEXT, specPath TEXT, logOffset INTEGER, taskJson TEXT, launchJson TEXT);
      CREATE TABLE config_overrides (key TEXT, value TEXT);
      INSERT INTO config_overrides VALUES ('GITHUB_TOKEN', 'do-not-return-configuration-secret');
      CREATE TABLE todos (sequence INTEGER, title TEXT, repo TEXT, description TEXT, acceptanceCriteria TEXT,
        priority TEXT, state TEXT, createdAt TEXT, updatedAt TEXT, completedAt TEXT, runId TEXT);
      INSERT INTO todos VALUES (1, 'In-flight task', 'org/first', 'Saved description', '', 'P2', 'in_progress',
        '2026-01-01', '2026-01-01', NULL, 'stopped-run');
      CREATE TABLE clarifications (id TEXT, runId TEXT, status TEXT);
      INSERT INTO clarifications VALUES ('orphan', 'missing-run', 'pending');`);
    const insert = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('active-run', 'T-1', 'org/first', 'codex', 'running', 1, null, '2026-01-01T00:00:00Z', null, 1.2,
      join(root, 'worktree'), 'detached', '{"secret":"do-not-return-host-secret"}', join(root, 'saved.log'),
      join(root, 'exit.json'), join(root, 'spec.json'), 99, '{"secret":"do-not-return-task-secret"}', '{"secret":"do-not-return-launch-secret"}');
    insert.run('stopped-run', 'T-2', 'org/second', 'command', 'stopped', 2, 12, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', null,
      null, 'detached', null, null, null, null, 0, null, null);
  } finally { db.close(); }
  await mkdir(join(root, 'worktree'));
  await writeFile(join(root, 'worktree', 'uncommitted.txt'), 'Keep this worktree');
  await writeFile(join(root, 'saved.log'), 'Keep this log');
  await writeFile(join(root, 'exit.json'), '{"code":0}');
  await writeFile(join(root, 'spec.json'), '{"secret":"do-not-return-spec-secret"}');
  await mkdir(join(pluginsDir, 'artifacts'), { recursive: true });
  await writeFile(join(pluginsDir, 'artifacts', `${hash}.json`), 'corrupt provider artifact must not be read or removed');
  const plugins = new Database(join(pluginsDir, 'catalog.sqlite'));
  try {
    plugins.exec('CREATE TABLE plugin_packages (id TEXT, hash TEXT, enabled INTEGER); CREATE TABLE plugin_bindings (slot TEXT, contribution TEXT);');
    plugins.prepare('INSERT INTO plugin_packages VALUES (?, ?, ?)').run('example.broken', hash, 1);
    plugins.prepare('INSERT INTO plugin_bindings VALUES (?, ?)').run(COSTS_PAGE_SLOT, 'example.broken/page');
  } finally { plugins.close(); }
}

const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

describe('safe start configuration', () => {
  it('accepts either the explicit CLI switch or the explicit environment flag', () => {
    expect(safeStartEnabled(['--safe-start'], {})).toBe(true);
    expect(safeStartEnabled([], { HELMSMAN_SAFE_START: '1' })).toBe(true);
    expect(safeStartEnabled(['--safe-start'], { HELMSMAN_SAFE_START: '0' })).toBe(true);
    expect(safeStartEnabled([], {})).toBe(false);
    expect(safeStartEnabled([], { HELMSMAN_SAFE_START: 'true', HELMSMAN_PLUGIN_UI_SAFE_MODE: '1' })).toBe(false);
  });
});

describe('safe start recovery server', () => {
  it('reports blocked active work and checkpoint metadata without secrets, recovery, reconciliation, or artifact changes', async () => {
    await seed();
    const files = [dbPath, join(pluginsDir, 'catalog.sqlite'), join(root, 'saved.log'), join(root, 'exit.json'),
      join(root, 'spec.json'), join(root, 'worktree', 'uncommitted.txt'), join(pluginsDir, 'artifacts', `${hash}.json`)];
    const before = await Promise.all(files.map(digest));
    await start({ RUN_HOST: 'docker', GITHUB_TOKEN: 'do-not-return-env-secret', SLACK_ENABLED: 'true', GITHUB_REVIEW_WATCH_ENABLED: 'true' });
    const response = await fetch(`${base}/api/recovery`);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ mode: 'safe-start', readOnly: true, totalRuns: 2, truncated: false, errors: [],
      plugins: [{ id: 'example.broken', hash, enabled: true }] });
    expect(body.runs[0]).toMatchObject({ id: 'active-run', status: 'running', attachment: 'blocked', logOffset: 99 });
    expect(body.runs[0]).not.toHaveProperty('specPath');
    expect(body.runs[0]).not.toHaveProperty('worktreePath');
    expect(body.runs[1]).toMatchObject({ id: 'stopped-run', status: 'stopped', attachment: 'inactive' });
    expect(text).not.toContain('do-not-return');
    expect(text).not.toContain('hostRef');
    expect(text).not.toContain('taskJson');
    expect(text).not.toContain('launchJson');
    expect(await Promise.all(files.map(digest))).toEqual(before);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT state FROM todos').get()).toEqual({ state: 'in_progress' });
      expect(db.prepare('SELECT status FROM clarifications').get()).toEqual({ status: 'pending' });
    } finally { db.close(); }
  });

  it('publishes safe-mode metadata and keeps corrupt optional artifacts unavailable', async () => {
    await seed();
    await start();
    const response = await fetch(`${base}/api/plugins/catalog`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: 1, safeMode: true, plugins: [], bindings: { [COSTS_PAGE_SLOT]: 'example.broken/page' } });
    expect(await (await fetch(`${base}/api/plugins/manage`)).json()).toMatchObject({ version: 1, plugins: [], readOnly: true,
      reason: 'Plugin management is disabled in safe start.' });
    expect((await fetch(`${base}/api/plugins/manage`, { method: 'POST' })).status).toBe(503);
    expect((await fetch(`${base}/plugin-assets/example.broken/${hash}/page.js`)).status).toBe(404);
  });

  it('reads every supported binding without evaluating artifacts or modifying stored metadata', async () => {
    await seed();
    const path = join(pluginsDir, 'catalog.sqlite');
    const plugins = new Database(path);
    const bindings = Object.fromEntries(builtinPageSlots.map(slot => [slot.id, slot.defaultContributionId]));
    try {
      plugins.exec('DELETE FROM plugin_bindings');
      const insert = plugins.prepare('INSERT INTO plugin_bindings VALUES (?, ?)');
      for (const [slot, contribution] of Object.entries(bindings)) insert.run(slot, contribution);
    } finally { plugins.close(); }
    const before = await digest(path);
    await start();
    expect(await (await fetch(`${base}/api/plugins/catalog`)).json()).toMatchObject({ safeMode: true, bindings });
    expect(await (await fetch(`${base}/api/recovery`)).json()).toMatchObject({
      plugins: [{ id: 'example.broken', hash, enabled: true }], errors: [],
    });
    expect(await digest(path)).toBe(before);
  });

  it.each(['helmsman/unknown-page', 'invalid'])('rejects unsupported stored slot %s without modifying metadata', async slot => {
    await seed();
    const path = join(pluginsDir, 'catalog.sqlite');
    const plugins = new Database(path);
    try { plugins.prepare('INSERT INTO plugin_bindings VALUES (?, ?)').run(slot, 'example.broken/page'); }
    finally { plugins.close(); }
    const before = await digest(path);
    await start();
    expect(await (await fetch(`${base}/api/recovery`)).json()).toMatchObject({ plugins: [], errors: ['Stored recovery metadata could not be read. Files were left unchanged.'] });
    expect(await digest(path)).toBe(before);
  });

  it('keeps core recovery available with missing frontend assets and leaves all stored data unchanged', async () => {
    await seed();
    const files = [dbPath, join(pluginsDir, 'catalog.sqlite'), join(root, 'saved.log'), join(root, 'exit.json'),
      join(root, 'spec.json'), join(root, 'worktree', 'uncommitted.txt'), join(pluginsDir, 'artifacts', `${hash}.json`)];
    const before = await Promise.all(files.map(digest));
    await rm(dist, { recursive: true });
    await start();
    const page = await fetch(`${base}/recovery`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Safe start');
    expect(html).toContain('active-run');
    expect(html).not.toContain('<script');
    const diagnostic = await fetch(`${base}/api/recovery`);
    expect(diagnostic.status).toBe(200);
    expect(await diagnostic.json()).toMatchObject({ mode: 'safe-start', readOnly: true, errors: [],
      runs: [expect.objectContaining({ id: 'active-run', status: 'running', attachment: 'blocked' }),
        expect.objectContaining({ id: 'stopped-run', status: 'stopped' })] });
    const catalog = await fetch(`${base}/api/plugins/catalog`);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ version: 1, safeMode: true, plugins: [],
      bindings: { [COSTS_PAGE_SLOT]: 'example.broken/page' } });
    const missing = await fetch(`${base}/assets/missing.js`);
    expect(missing.status).toBe(500);
    expect(await missing.json()).toEqual({ error: 'Recovery request failed; stored data was left unchanged.' });
    expect((await fetch(`${base}/recovery`)).status).toBe(200);
    expect(await Promise.all(files.map(digest))).toEqual(before);
  });

  it('opens fresh installations without creating application or plugin databases', async () => {
    await start();
    expect(await (await fetch(`${base}/api/recovery`)).json()).toMatchObject({ runs: [], plugins: [], errors: [] });
    expect(await readdir(root)).toEqual(['dist']);
  });

  it('keeps diagnostics available when either database is corrupt and avoids leaking paths or contents in errors', async () => {
    await writeFile(dbPath, 'do-not-return-corrupt-db-secret');
    await mkdir(pluginsDir);
    await writeFile(join(pluginsDir, 'catalog.sqlite'), 'do-not-return-corrupt-plugin-secret');
    await start();
    const result = await (await fetch(`${base}/api/recovery`)).json();
    expect(result.errors).toHaveLength(2);
    expect(result.runs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('do-not-return');
    expect(await readFile(dbPath, 'utf8')).toBe('do-not-return-corrupt-db-secret');
  });

  it('supports reading legacy run schemas without migrations', async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE runs (id TEXT, startedAt TEXT, status TEXT); INSERT INTO runs VALUES ('legacy', '2020-01-01', 'running')");
    db.close();
    const before = await digest(dbPath);
    await start();
    const result = await (await fetch(`${base}/api/recovery`)).json();
    expect(result.runs[0]).toMatchObject({ id: 'legacy', attachment: 'blocked', logOffset: null });
    expect(await digest(dbPath)).toBe(before);
  });

  it('serves stored run history, scope, tasks, and the core recovery page without provider calls', async () => {
    await seed();
    await start({ REPO_PROJECT_MAP: 'org/configured=JIRA', GITHUB_REPO: 'org/github', JIRA_ENABLED: 'false' });
    expect(await (await fetch(`${base}/api/context`)).json()).toEqual({
      repos: ['org/configured', 'org/first', 'org/github', 'org/second'], jiraEnabled: false, jiraBaseUrl: null,
    });
    const runs = await (await fetch(`${base}/api/runs?repo=org/first&limit=25&offset=0`)).json();
    expect(runs).toMatchObject({ total: 1, limit: 25, offset: 0 });
    expect(runs.runs.map((run: { id: string }) => run.id)).toEqual(['active-run']);
    expect((await (await fetch(`${base}/api/agents/active-run`)).json()).status).toBe('running');
    expect((await fetch(`${base}/api/agents/missing-run`)).status).toBe(404);
    expect((await (await fetch(`${base}/api/todos?repo=org/first`)).json()).todos[0]).toMatchObject({ id: 'TODO-1', state: 'in_progress' });
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ config: { JIRA_ENABLED: 'false' }, overridden: [], jiraTokenSet: false });
    expect(await (await fetch(`${base}/api/github/profile`)).json()).toEqual({ displayName: null, login: null });
    expect((await (await fetch(`${base}/api/slack`)).json()).health.status).toBe('disabled');
    expect(await (await fetch(`${base}/recovery`)).text()).toContain('Safe start');
    expect(await (await fetch(`${base}/runs`)).text()).toContain('Stored application');
    expect(await (await fetch(`${base}/plugins/example.broken/page`)).text()).toContain('Stored application');
  });

  it.each([
    ['POST', '/api/agents/launch'], ['POST', '/api/agents/active-run/resume'], ['POST', '/api/agents/active-run/stop'],
    ['PUT', '/api/config'], ['POST', '/api/webhooks/github'], ['POST', '/api/slack/review-request'],
    ['POST', '/api/cmux/send'], ['PUT', '/api/todos/TODO-1'], ['DELETE', '/api/todos/TODO-1'],
    ['GET', '/api/runs/active-run/clarification-gate'], ['GET', '/api/clarifications'], ['GET', '/api/campaigns'],
    ['GET', '/api/cmux/events'], ['GET', '/api/cmux/tabs'], ['GET', '/api/dashboard'], ['GET', '/api/local-git'],
    ['POST', '/api/unknown-new-route'], ['GET', '/api/unknown-new-route'],
  ])('blocks %s %s before any provider-dependent route can run', async (method, path) => {
    await start();
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SAFE_START' });
    expect(await readdir(root)).toEqual(['dist']);
  });

  it('validates filters and pagination while honoring HEAD without bodies', async () => {
    await seed();
    await start();
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=NaN', 'repo=../other']) {
      expect((await fetch(`${base}/api/runs?${query}`)).status).toBe(400);
    }
    for (const path of ['/api/recovery', '/api/runs', '/api/plugins/catalog', '/api/plugins/manage', '/recovery', '/runs']) {
      const response = await fetch(`${base}${path}`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
  });

  it('does not serve symlink targets outside the distribution directory', async () => {
    await writeFile(join(root, 'private.txt'), 'do-not-return-private-file');
    await symlink(join(root, 'private.txt'), join(dist, 'leak.txt'));
    await start();
    const response = await fetch(`${base}/leak.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('do-not-return');
  });
});

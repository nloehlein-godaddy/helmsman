import Database from 'better-sqlite3';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { isAppPagePath } from '../../src/logic/routes';
import { COSTS_PAGE_SLOT } from '../../src/plugins/builtins';
import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import { handlePluginRequest } from './plugins/http';
import type { PluginSnapshot } from './plugins/store';

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
const RUN_COLUMNS = ['id', 'ticketId', 'repo', 'adapter', 'status', 'attempt', 'prNumber', 'startedAt', 'endedAt',
  'costUsd', 'worktreePath', 'hostKind', 'logPath', 'exitPath', 'specPath', 'logOffset'] as const;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const disabled = { error: 'This operation is unavailable in safe start. Restart normally after resolving recovery issues.', code: 'SAFE_START' };

export interface SafeStartOptions {
  dbPath: string;
  pluginsDir?: string;
  dist: string;
  env?: Env;
}

export function safeStartEnabled(args: readonly string[], env: Env): boolean {
  return env.HELMSMAN_SAFE_START === '1' || args.includes('--safe-start');
}

function readDatabase<T>(path: string, fallback: T, read: (sql: Database.Database) => T): { value: T; error: string | null } {
  if (!existsSync(path)) return { value: fallback, error: null };
  let sql: Database.Database | undefined;
  try {
    sql = new Database(path, { readonly: true, fileMustExist: true });
    sql.pragma('query_only = ON');
    return { value: read(sql), error: null };
  } catch {
    return { value: fallback, error: 'Stored recovery metadata could not be read. Files were left unchanged.' };
  } finally { sql?.close(); }
}

function hasTable(sql: Database.Database, table: string): boolean {
  return Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function readRuns(path: string, limit: number, offset = 0, repo: string | null = null, id: string | null = null) {
  return readDatabase(path, { runs: [] as Row[], total: 0 }, sql => {
    if (!hasTable(sql, 'runs')) return { runs: [], total: 0 };
    const columns = new Set((sql.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map(column => column.name));
    const projection = RUN_COLUMNS.map(column => columns.has(column) ? `"${column}"` : `NULL AS "${column}"`).join(', ');
    const clauses: string[] = [];
    const bindings: string[] = [];
    if (repo !== null) { clauses.push('repo = ? COLLATE NOCASE'); bindings.push(repo); }
    if (id !== null) { clauses.push('id = ?'); bindings.push(id); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const count = sql.prepare(`SELECT COUNT(*) AS total FROM runs${where}`).get(...bindings) as { total: number };
    const runs = sql.prepare(`SELECT ${projection} FROM runs${where} ORDER BY startedAt DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...bindings, limit, offset) as Row[];
    return { runs, total: count?.total ?? 0 };
  });
}

function readPlugins(root: string) {
  return readDatabase(join(root, 'catalog.sqlite'), { plugins: [] as { id: string; hash: string; enabled: boolean }[], bindings: {} as Record<string, string> }, sql => {
    const rows = hasTable(sql, 'plugin_packages')
      ? sql.prepare('SELECT id, hash, enabled FROM plugin_packages ORDER BY id').all() as Row[] : [];
    if (rows.length > 32 || rows.some(row => !isPluginId(row?.id) || row.id.startsWith('helmsman.')
      || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash) || row.enabled !== 0 && row.enabled !== 1)) {
      throw new Error('Invalid installed plugin metadata');
    }
    const bindings: Record<string, string> = {};
    const bindingRows = hasTable(sql, 'plugin_bindings')
      ? sql.prepare('SELECT slot, contribution FROM plugin_bindings').all() as Row[] : [];
    for (const row of bindingRows) {
      if (row?.slot !== COSTS_PAGE_SLOT || !isContributionId(row.contribution)) throw new Error('Invalid page binding');
      bindings[row.slot] = row.contribution;
    }
    return { plugins: rows.map(row => ({ id: row.id as string, hash: row.hash as string, enabled: row.enabled === 1 })), bindings };
  });
}

function readTodos(path: string, repo: string | null = null) {
  return readDatabase<Row[]>(path, [], sql => {
    if (!hasTable(sql, 'todos')) return [];
    const query = "SELECT 'TODO-' || sequence AS id, title, repo, description, acceptanceCriteria, priority, state, createdAt, updatedAt, completedAt, runId FROM todos";
    return sql.prepare(`${query}${repo === null ? '' : ' WHERE repo = ? COLLATE NOCASE'} ORDER BY priority, sequence LIMIT 1000`)
      .all(...(repo === null ? [] : [repo])) as Row[];
  });
}

function recovery(options: SafeStartOptions, pluginsDir: string) {
  const runs = readRuns(options.dbPath, 1000);
  const plugins = readPlugins(pluginsDir);
  return {
    mode: 'safe-start' as const, readOnly: true,
    runs: runs.value.runs.map(run => ({ ...run, attachment: run.status === 'running' ? 'blocked' : 'inactive',
      ...(run.status === 'running' ? { blockedReason: 'Provider recovery is disabled in safe start.' } : {}) })),
    totalRuns: runs.value.total,
    truncated: runs.value.total > runs.value.runs.length,
    plugins: plugins.value.plugins,
    errors: [runs.error, plugins.error].filter((error): error is string => error !== null),
  };
}

function json(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : JSON.stringify(body));
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const validRepo = (value: string | null) => value === null || /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value);

export function createSafeStartServer(options: SafeStartOptions): Server {
  const env = options.env ?? {};
  const pluginsDir = options.pluginsDir ?? join(homedir(), '.helmsman', 'plugins');
  const installed = readPlugins(pluginsDir);
  const snapshot: PluginSnapshot = { catalog: { version: 1, safeMode: true, plugins: [], bindings: installed.value.bindings },
    artifacts: new Map(), errors: installed.error ? [installed.error] : [] };
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const readOnly = req.method === 'GET' || req.method === 'HEAD';
      const head = req.method === 'HEAD';
      if (!readOnly) { json(res, 503, disabled); return; }
      if (handlePluginRequest(req, res, url, snapshot)) return;
      if (url.pathname === '/api/recovery') { json(res, 200, recovery(options, pluginsDir), head); return; }
      if (url.pathname === '/recovery') {
        const data = escapeHtml(JSON.stringify(recovery(options, pluginsDir), null, 2));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(head ? undefined : `<!doctype html><html lang="en"><meta charset="utf-8"><title>Helmsman recovery</title><main><h1>Safe start</h1><p>Provider recovery, background work, page plugins, and mutations are disabled. Existing work and artifacts are preserved.</p><p><a href="/runs">Stored runs</a> · <a href="/api/recovery">Recovery JSON</a></p><p>Use the plugin CLI to disable a failing package or install a compatible archive while it is disabled, then restart Helmsman normally.</p><pre>${data}</pre></main></html>`);
        return;
      }
      const repo = url.searchParams.get('repo');
      if (!validRepo(repo)) { json(res, 400, { error: 'Invalid galleon filter.' }, head); return; }
      if (url.pathname === '/api/context') {
        const runs = readRuns(options.dbPath, 1000).value.runs;
        const todos = readTodos(options.dbPath).value;
        const configured = [...(env.REPO_PROJECT_MAP ?? '').split(',').map(pair => pair.split('=')[0]?.trim()), env.GITHUB_REPO];
        const repos = [...new Set([...configured, ...runs.map(run => run.repo), ...todos.map(todo => todo.repo)]
          .filter((value): value is string => typeof value === 'string' && Boolean(value) && validRepo(value)))].sort();
        json(res, 200, { repos, jiraEnabled: env.JIRA_ENABLED !== 'false', jiraBaseUrl: null }, head); return;
      }
      if (url.pathname === '/api/agents') {
        const result = readRuns(options.dbPath, 50);
        json(res, result.error ? 503 : 200, result.error ? { error: result.error } : {
          runs: result.value.runs, autoClaim: [], caps: { maxAttempts: 0, maxCostUsd: null },
        }, head); return;
      }
      if (url.pathname === '/api/runs') {
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
          json(res, 400, { error: 'Invalid run history pagination.' }, head); return;
        }
        const result = readRuns(options.dbPath, limit, offset, repo);
        json(res, result.error ? 503 : 200, result.error ? { error: result.error } : { ...result.value, limit, offset }, head); return;
      }
      const runId = /^\/api\/agents\/([a-z\d_-]{1,128})$/i.exec(url.pathname)?.[1];
      if (runId) {
        const result = readRuns(options.dbPath, 1, 0, null, runId);
        const run = result.value.runs[0];
        json(res, result.error ? 503 : run ? 200 : 404, result.error ? { error: result.error } : run ?? { error: 'Run not found.' }, head); return;
      }
      if (url.pathname === '/api/todos') {
        const result = readTodos(options.dbPath, repo);
        json(res, result.error ? 503 : 200, result.error ? { error: result.error } : { todos: result.value }, head); return;
      }
      if (url.pathname === '/api/config') {
        json(res, 200, { config: { JIRA_ENABLED: env.JIRA_ENABLED !== 'false' ? 'true' : 'false' }, overridden: [], jiraTokenSet: false }, head); return;
      }
      if (url.pathname === '/api/slack') {
        json(res, 200, { health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000,
          lastSuccessAt: null, error: 'Background work is disabled in safe start.' }, notifications: [] }, head); return;
      }
      if (url.pathname === '/api/github/profile') { json(res, 200, { displayName: null, login: null }, head); return; }
      if (url.pathname === '/api/usage/external') { json(res, 200, null, head); return; }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) { json(res, 503, disabled, head); return; }
      const base = await realpath(options.dist);
      const path = resolve(base, `.${isAppPagePath(url.pathname) ? '/index.html' : url.pathname}`);
      if (!path.startsWith(`${base}${sep}`)) { json(res, 404, { error: 'Not found.' }, head); return; }
      try {
        const actual = await realpath(path);
        if (!actual.startsWith(`${base}${sep}`) || !(await stat(actual)).isFile()) {
          json(res, 404, { error: 'Not found.' }, head); return;
        }
        const content = await readFile(actual);
        res.writeHead(200, { 'Content-Type': MIME[extname(actual)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
        res.end(head ? undefined : content);
      } catch { json(res, 404, { error: 'Not found.' }, head); }
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Recovery request failed; stored data was left unchanged.' });
      else res.end();
    });
  });
}

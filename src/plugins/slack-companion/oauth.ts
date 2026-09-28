import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { record } from './transport.js';

export const SLACK_USER_SCOPES = ['channels:read', 'chat:write', 'search:read'] as const;
const SETUP = 'Configure the Slack app client ID, client secret, HTTPS callback URL, workspace ID, and private token file.';
const CONNECT = 'Connect your Slack account to use Slack MCP.';
const FAILURE = 'Slack authorization failed. Check the app configuration and reconnect.';
const REFRESH = 'Slack authorization could not be refreshed. Try again or reconnect your Slack account.';
const STATE = 'Slack authorization expired or could not be verified. Start connecting again.';
const STORAGE = 'Slack OAuth token file must be an absolute, private regular file owned by this user, without symlinks.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[^\x21-\x7e]/.test(value);
const teamId = (value: unknown): value is string => typeof value === 'string' && /^T[A-Z\d]{2,31}$/.test(value);
const userId = (value: unknown): value is string => typeof value === 'string' && /^[UW][A-Z\d]{2,31}$/.test(value);

interface Settings { clientId: string; clientSecret: string; redirectUri: string; teamId: string; path: string }
interface Token { accessToken: string; refreshToken: string | null; expiresAt: number | null; teamId: string; userId: string; grantId: string }
interface Store { version: 1; binding: string; revision: string; grant: Token | null; pending: { hash: string; expiresAt: number } | null; error: string | null }
export interface SlackConnectionStatus { status: 'setup-required' | 'disconnected' | 'connected' | 'error'; message: string; accountLabel: string | null; redirectUri: string | null }

export function usesSlackOAuth(env: Readonly<Record<string, string | undefined>>): boolean {
  return ['SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET', 'SLACK_OAUTH_REDIRECT_URI', 'SLACK_OAUTH_TOKEN_FILE'].some(key => Boolean(env[key]?.trim()));
}

function settings(env: Readonly<Record<string, string | undefined>>): Settings {
  const value = { clientId: env.SLACK_OAUTH_CLIENT_ID ?? '', clientSecret: env.SLACK_OAUTH_CLIENT_SECRET ?? '', redirectUri: env.SLACK_OAUTH_REDIRECT_URI ?? '', teamId: env.SLACK_CLIENT_ID ?? '', path: env.SLACK_OAUTH_TOKEN_FILE ?? '' };
  let url: URL;
  try { url = new URL(value.redirectUri); } catch { throw new Error(SETUP); }
  if (!secret(value.clientId) || !secret(value.clientSecret) || !teamId(value.teamId) || !isAbsolute(value.path)
    || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/communication-connection/callback') throw new Error(SETUP);
  return { ...value, redirectUri: url.href };
}

function privateDirectory(path: string, create = false): void {
  const directory = dirname(path);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) throw new Error(STORAGE);
}

function readStore(path: string): Store | null {
  let fd: number | undefined;
  try {
    privateDirectory(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error(STORAGE);
    const value = record(JSON.parse(readFileSync(fd, 'utf8')));
    const grant = record(value?.grant);
    const pending = record(value?.pending);
    if (value?.version !== 1 || typeof value.binding !== 'string' || !/^[a-f\d]{64}$/.test(value.binding)
      || typeof value.revision !== 'string' || !/^[a-f\d-]{36}$/.test(value.revision)
      || (value.error !== null && ![FAILURE, REFRESH].includes(String(value.error)))
      || (value.grant !== null && (!grant || !secret(grant.accessToken) || (grant.refreshToken !== null && !secret(grant.refreshToken))
        || (grant.expiresAt !== null && (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)))
        || !teamId(grant.teamId) || !userId(grant.userId) || typeof grant.grantId !== 'string' || !/^[a-f\d-]{36}$/.test(grant.grantId)))
      || (value.pending !== null && (!pending || typeof pending.hash !== 'string' || !/^[a-f\d]{64}$/.test(pending.hash) || typeof pending.expiresAt !== 'number' || !Number.isFinite(pending.expiresAt)))) throw new Error(STORAGE);
    return value as unknown as Store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error(STORAGE);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writeStore(path: string, value: Store): void {
  let fd: number | undefined;
  const temporary = join(dirname(path), `.slack-oauth-${randomUUID()}.tmp`);
  try {
    privateDirectory(path, true);
    readStore(path);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } catch { throw new Error(STORAGE); }
  finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
}

function parseToken(value: unknown, now: number): Pick<Token, 'accessToken' | 'refreshToken' | 'expiresAt'> {
  const data = record(value);
  const refreshToken = data?.refresh_token ?? null;
  const scopes = new Set(typeof data?.scope === 'string' ? data.scope.split(/[\s,]+/) : []);
  const expires = data?.expires_in;
  if (!secret(data?.access_token) || data.token_type !== 'user' || SLACK_USER_SCOPES.some(scope => !scopes.has(scope))
    || (refreshToken !== null && !secret(refreshToken)) || (expires !== undefined && (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= 0 || !refreshToken || !Number.isSafeInteger(now + expires * 1000)))) throw new Error(FAILURE);
  return { accessToken: data.access_token, refreshToken, expiresAt: typeof expires === 'number' ? now + expires * 1000 : null };
}

export function createSlackOAuth(options: { env: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch; now?: () => number }) {
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  let refreshing: { revision: string; promise: Promise<string> } | null = null;
  function context() {
    const config = settings(options.env);
    const binding = hash(JSON.stringify(config));
    let store = readStore(config.path);
    if (store && store.binding !== binding) {
      store = { version: 1, binding, revision: randomUUID(), grant: null, pending: null, error: null };
      writeStore(config.path, store);
    }
    return { config, store: store ?? { version: 1 as const, binding, revision: randomUUID(), grant: null, pending: null, error: null } };
  }
  function save(current: ReturnType<typeof context>, change: Partial<Store>) {
    const next = { ...current.store, ...change, revision: randomUUID() };
    writeStore(current.config.path, next);
    return { config: current.config, store: next };
  }
  function assertCurrent(expected: ReturnType<typeof context>, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = context();
    if (current.store.binding !== expected.store.binding || current.store.revision !== expected.store.revision) throw new Error(CONNECT);
  }
  function fail(current: ReturnType<typeof context>, message: typeof FAILURE | typeof REFRESH) {
    try { assertCurrent(current, new AbortController().signal); save(current, { error: message }); } catch {}
  }
  async function post(endpoint: 'oauth.v2.access' | 'auth.test', values: URLSearchParams, signal: AbortSignal, token?: string) {
    try {
      const response = await fetcher(`https://slack.com/api/${endpoint}`, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: values.toString() });
      if (!response.ok) { await response.body?.cancel(); throw new Error(FAILURE); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error(FAILURE);
      const decoder = new TextDecoder(); let body = ''; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          size += value?.byteLength ?? 0;
          if (size > 65_536) throw new Error(FAILURE);
          body += decoder.decode(value, { stream: !done });
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const data = record(JSON.parse(body));
      if (data?.ok !== true) throw new Error(FAILURE);
      return data;
    } catch { throw new Error(FAILURE); }
  }
  async function verify(token: string, expectedTeam: string, expectedUser: string, signal: AbortSignal) {
    const identity = await post('auth.test', new URLSearchParams(), signal, token);
    if (identity.team_id !== expectedTeam || identity.user_id !== expectedUser || identity.bot_id || identity.is_bot === true) throw new Error(FAILURE);
  }
  function identity(): string | null {
    try {
      const current = context(); const token = current.store.grant;
      return token && !current.store.error && (token.expiresAt === null || token.expiresAt > now())
        ? hash(JSON.stringify([current.store.binding, token.grantId, token.teamId, token.userId])) : null;
    } catch { return null; }
  }
  async function begin(signal: AbortSignal) {
    signal.throwIfAborted();
    const current = context();
    const state = randomBytes(32).toString('base64url');
    save(current, { pending: { hash: hash(state), expiresAt: now() + 10 * 60_000 } });
    refreshing = null;
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.search = new URLSearchParams({ client_id: current.config.clientId, redirect_uri: current.config.redirectUri, user_scope: SLACK_USER_SCOPES.join(','), state, team: current.config.teamId }).toString();
    return { authorizationUrl: url.href, state };
  }
  async function complete(query: URLSearchParams, cookieState: string, signal: AbortSignal, beforeCommit: () => void): Promise<void> {
    signal.throwIfAborted();
    let current = context();
    const state = query.get('state') ?? '';
    if (!/^[A-Za-z\d_-]{43}$/.test(state) || typeof cookieState !== 'string' || !timingSafeEqual(Buffer.from(hash(state)), Buffer.from(hash(cookieState)))
      || current.store.pending?.hash !== hash(state) || current.store.pending.expiresAt <= now()) throw new Error(STATE);
    current = save(current, { pending: null });
    try {
      const code = query.get('code');
      if (query.has('error') || !secret(code)) throw new Error(FAILURE);
      const data = await post('oauth.v2.access', new URLSearchParams({ client_id: current.config.clientId, client_secret: current.config.clientSecret, redirect_uri: current.config.redirectUri, code }), signal);
      assertCurrent(current, signal);
      const user = record(data.authed_user);
      const token = parseToken(user, now());
      if (record(data.team)?.id !== current.config.teamId || !userId(user?.id)) throw new Error(FAILURE);
      await verify(token.accessToken, current.config.teamId, user.id, signal);
      assertCurrent(current, signal);
      beforeCommit();
      assertCurrent(current, signal);
      save(current, { grant: { ...token, teamId: current.config.teamId, userId: user.id, grantId: randomUUID() }, error: null });
      refreshing = null;
    } catch { fail(current, FAILURE); throw new Error(FAILURE); }
  }
  async function accessToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const current = context(); const token = current.store.grant;
    if (!token) throw new Error(CONNECT);
    const needsRefresh = token.expiresAt !== null && token.expiresAt <= now() + 60_000;
    if (!needsRefresh && !current.store.error) return token.accessToken;
    if (refreshing?.revision === current.store.revision) {
      const result = await refreshing.promise; signal.throwIfAborted(); return result;
    }
    const promise = (async () => {
      try {
        let replacement = token;
        if (needsRefresh) {
          if (!token.refreshToken) throw new Error(REFRESH);
          const data = await post('oauth.v2.access', new URLSearchParams({ client_id: current.config.clientId, client_secret: current.config.clientSecret, grant_type: 'refresh_token', refresh_token: token.refreshToken }), signal);
          assertCurrent(current, signal);
          const changed = parseToken(data, now());
          if ((data.team_id && data.team_id !== token.teamId) || (record(data.team)?.id && record(data.team)?.id !== token.teamId) || (data.user_id && data.user_id !== token.userId)) throw new Error(REFRESH);
          replacement = { ...token, ...changed };
        }
        await verify(replacement.accessToken, token.teamId, token.userId, signal);
        assertCurrent(current, signal);
        save(current, { grant: replacement, error: null });
        return replacement.accessToken;
      } catch { fail(current, REFRESH); throw new Error(REFRESH); }
    })();
    const pending = { revision: current.store.revision, promise }; refreshing = pending;
    try { return await promise; } finally { if (refreshing === pending) refreshing = null; }
  }
  async function status(signal: AbortSignal): Promise<SlackConnectionStatus> {
    let current: ReturnType<typeof context>;
    try { settings(options.env); } catch { return { status: 'setup-required', message: SETUP, accountLabel: null, redirectUri: null }; }
    try {
      current = context();
      if (current.store.grant) { try { await accessToken(signal); } catch {} current = context(); }
      const connected = identity() !== null;
      return { status: current.store.error ? 'error' : connected ? 'connected' : 'disconnected', message: current.store.error ?? (connected ? 'Slack account connected.' : CONNECT),
        accountLabel: connected && current.store.grant ? `${current.store.grant.userId} · ${current.store.grant.teamId}` : null, redirectUri: current.config.redirectUri };
    } catch { return { status: 'error', message: STORAGE, accountLabel: null, redirectUri: null }; }
  }
  async function disconnect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); save(context(), { grant: null, pending: null, error: null }); refreshing = null;
  }
  async function check(signal: AbortSignal): Promise<void> {
    const token = await accessToken(signal); const current = context(); const grant = current.store.grant;
    if (!grant || grant.accessToken !== token) throw new Error(CONNECT);
    try { await verify(token, grant.teamId, grant.userId, signal); assertCurrent(current, signal); save(current, { error: null }); }
    catch { fail(current, FAILURE); throw new Error(FAILURE); }
  }
  return { identity, accessToken, status, begin, complete, disconnect, check };
}

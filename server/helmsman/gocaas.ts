import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1';
const HOSTS = new Set([
  'caas-gocode-prod.caas-prod.prod.onkatana.net',
  'caas-gocode-test.caas-test.prod.onkatana.net',
  'caas-gocode-dev.caas-dev.prod.onkatana.net',
  'api.gocode.caas.gdcorp.tools',
  'api.gocode.caas.test-gdcorp.tools',
  'api.gocode.caas.dev-gdcorp.tools',
]);

export type GoCaaSAuthMode = 'api-key' | 'sso-jwt';
export interface GoCaaSConfiguration { baseUrl: string; authMode: GoCaaSAuthMode; apiKeyHelper: string; }

export function loadGoCaaSConfiguration(env: NodeJS.ProcessEnv = process.env): GoCaaSConfiguration {
  const baseUrl = env.GOCAAS_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || !['', '/', '/v1'].includes(parsed.pathname)
    || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid GoCaaS base URL');
  const authMode = env.GOCAAS_AUTH_MODE?.trim() || 'api-key';
  if (authMode !== 'api-key' && authMode !== 'sso-jwt') throw new Error('Invalid GoCaaS auth mode');
  const normalizedPath = parsed.pathname === '' || parsed.pathname === '/' ? '/v1' : parsed.pathname;
  return { baseUrl: `${parsed.origin}${normalizedPath}`, authMode, apiKeyHelper: env.GOCAAS_API_KEY_HELPER?.trim() || `${homedir()}/.gocode/bin/gocode` };
}

export interface GoCaaSUpstream { baseUrl: string; authMode: GoCaaSAuthMode; credential: () => Promise<string | undefined>; assertReady: () => Promise<void>; }

export function createGoCaaSUpstream(env: NodeJS.ProcessEnv = process.env): GoCaaSUpstream {
  const config = loadGoCaaSConfiguration(env);
  let cached: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string | undefined> | undefined;
  const credential = async (): Promise<string | undefined> => {
    if (env.GOCAAS_API_KEY?.trim()) return env.GOCAAS_API_KEY.trim();
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = execFileAsync(config.apiKeyHelper, ['api-key-helper'], { timeout: 5_000, maxBuffer: 16_384, windowsHide: true })
      .then(result => { const value = result.stdout.trim(); if (!value) return undefined; cached = { value, expiresAt: Date.now() + 60_000 }; return value; })
      .catch(() => undefined)
      .finally(() => { pending = undefined; });
    return pending;
  };
  const assertReady = async (): Promise<void> => {
    if (env.GOCAAS_API_KEY?.trim()) return;
    try { await access(config.apiKeyHelper, constants.X_OK); } catch { throw new Error('GoCaaS credential helper is unavailable'); }
  };
  return { baseUrl: config.baseUrl, authMode: config.authMode, credential, assertReady };
}

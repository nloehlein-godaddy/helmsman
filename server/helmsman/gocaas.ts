import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1';
const HOSTS = new Set([
  'caas-gocode-prod.caas-prod.prod.onkatana.net',
  'caas-gocode.caas.prod.onkatana.net',
  'caas-gocode-test.caas-test.prod.onkatana.net',
  'caas-gocode-dev.caas-dev.prod.onkatana.net',
  'api.gocode.caas.gdcorp.tools',
  'api.gocode.caas.test-gdcorp.tools',
  'api.gocode.caas.dev-gdcorp.tools',
]);

export class GoCaaSConfigurationError extends Error {}

export type GoCaaSAuthMode = 'api-key' | 'sso-jwt';
export interface GoCaaSConfiguration { baseUrl: string; authMode: GoCaaSAuthMode; apiKeyHelper: string; }

export function loadGoCaaSConfiguration(env: NodeJS.ProcessEnv = process.env): GoCaaSConfiguration {
  const baseUrl = env.GOCAAS_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new GoCaaSConfigurationError('Invalid GoCaaS base URL'); }
  if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || !['', '/', '/v1', '/v1/'].includes(parsed.pathname)
    || parsed.port || parsed.search || parsed.hash || parsed.username || parsed.password) throw new GoCaaSConfigurationError('Invalid GoCaaS base URL');
  const authMode = env.GOCAAS_AUTH_MODE?.trim() || 'api-key';
  if (authMode !== 'api-key' && authMode !== 'sso-jwt') throw new GoCaaSConfigurationError('Invalid GoCaaS auth mode');
  const helper = env.GOCAAS_API_KEY_HELPER?.trim() || join(homedir(), '.gocode/bin/gocode');
  const apiKeyHelper = helper.startsWith('~/') ? join(homedir(), helper.slice(2)) : helper;
  if (!isAbsolute(apiKeyHelper) || /[\x00-\x1f\x7f]/.test(apiKeyHelper)) throw new GoCaaSConfigurationError('GoCaaS credential helper must be an absolute executable path');
  return { baseUrl: `${parsed.origin}/v1`, authMode, apiKeyHelper };
}

function validCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 16_384 && !/[\x00-\x20\x7f]/.test(trimmed) ? trimmed : undefined;
}

export interface GoCaaSUpstream { baseUrl: string; authMode: GoCaaSAuthMode; credential: () => Promise<string | undefined>; assertReady: () => void; }

export function createGoCaaSUpstream(env: NodeJS.ProcessEnv = process.env): GoCaaSUpstream {
  const config = loadGoCaaSConfiguration(env);
  let cached: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string | undefined> | undefined;
  const credential = async (): Promise<string | undefined> => {
    if (env.GOCAAS_API_KEY?.trim()) return validCredential(env.GOCAAS_API_KEY);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = execFileAsync(config.apiKeyHelper, ['api-key-helper'], { timeout: 5_000, maxBuffer: 16_384, windowsHide: true })
      .then(result => { const value = validCredential(result.stdout); if (!value) return undefined; cached = { value, expiresAt: Date.now() + 60_000 }; return value; })
      .catch(() => undefined)
      .finally(() => { pending = undefined; });
    return pending;
  };
  const assertReady = (): void => {
    if (env.GOCAAS_API_KEY?.trim()) {
      if (!validCredential(env.GOCAAS_API_KEY)) throw new GoCaaSConfigurationError('GoCaaS credential is invalid');
      return;
    }
    try { accessSync(config.apiKeyHelper, constants.X_OK); } catch { throw new GoCaaSConfigurationError('GoCaaS credential helper is unavailable; configure GOCAAS_API_KEY or install gocode before launching agents.'); }
  };
  return { baseUrl: config.baseUrl, authMode: config.authMode, credential, assertReady };
}

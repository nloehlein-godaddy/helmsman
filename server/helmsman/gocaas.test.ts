import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoCaaSUpstream, loadGoCaaSConfiguration } from './gocaas';

describe('GoCaaS configuration', () => {
  it('defaults to the production GoCaaS v1 endpoint and helper', () => {
    const config = loadGoCaaSConfiguration({ HOME: '/tmp', NODE_ENV: 'test' });
    expect(config.baseUrl).toBe('https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1');
    expect(config.authMode).toBe('api-key');
    expect(config.apiKeyHelper).toMatch(/\.gocode\/bin\/gocode$/);
  });

  it.each(['http://caas-gocode-prod.caas-prod.prod.onkatana.net/v1', 'https://evil.example/v1', 'https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1?x=1', 'https://caas-gocode-prod.caas-prod.prod.onkatana.net/foo'])('rejects unsafe endpoint %s', baseUrl => {
    expect(() => loadGoCaaSConfiguration({ GOCAAS_BASE_URL: baseUrl })).toThrow('Invalid GoCaaS base URL');
  });

  it('accepts explicit sso-jwt mode and helper override without exposing credentials', () => {
    expect(loadGoCaaSConfiguration({ GOCAAS_BASE_URL: 'https://api.gocode.caas.dev-gdcorp.tools/v1', GOCAAS_AUTH_MODE: 'sso-jwt', GOCAAS_API_KEY_HELPER: '/bin/helper' })).toEqual({
      baseUrl: 'https://api.gocode.caas.dev-gdcorp.tools/v1', authMode: 'sso-jwt', apiKeyHelper: '/bin/helper'
    });
  });

  it('normalizes an approved host root to the v1 API base', () => {
    expect(loadGoCaaSConfiguration({ GOCAAS_BASE_URL: 'https://api.gocode.caas.gdcorp.tools' }).baseUrl)
      .toBe('https://api.gocode.caas.gdcorp.tools/v1');
  });
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function helper(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-gocaas-')); roots.push(root);
  const file = join(root, 'credential.mjs');
  await writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { root, file };
}

it('checks helper readiness without execution and coalesces refreshes without exposing the key in configuration', async () => {
  const fixture = await helper("import { appendFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; appendFileSync(fileURLToPath(new URL('./calls', import.meta.url)), process.argv[2]+'\\n'); process.stdout.write('fixture-key');");
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const upstream = createGoCaaSUpstream({ GOCAAS_API_KEY_HELPER: fixture.file });
  upstream.assertReady();
  await expect(readFile(join(fixture.root, 'calls'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await Promise.all([upstream.credential(), upstream.credential()])).toEqual(['fixture-key', 'fixture-key']);
  expect(await upstream.credential()).toBe('fixture-key');
  expect(await readFile(join(fixture.root, 'calls'), 'utf8')).toBe('api-key-helper\n');
  expect(JSON.stringify(upstream)).not.toContain('fixture-key');
  clock.mockReturnValue(62_000);
  expect(await upstream.credential()).toBe('fixture-key');
  expect(await readFile(join(fixture.root, 'calls'), 'utf8')).toBe('api-key-helper\napi-key-helper\n');
});

it('uses the configured GoCaaS credential and never falls back to direct provider credentials', async () => {
  const configured = createGoCaaSUpstream({ GOCAAS_API_KEY: 'gocaas-fixture', GOCAAS_API_KEY_HELPER: '/missing/helper' });
  expect(() => configured.assertReady()).not.toThrow();
  expect(await configured.credential()).toBe('gocaas-fixture');
  const absent = createGoCaaSUpstream({ OPENAI_API_KEY: 'direct-key', ANTHROPIC_API_KEY: 'direct-key', GOCAAS_API_KEY_HELPER: '/missing/helper' });
  expect(() => absent.assertReady()).toThrow('GoCaaS credential helper is unavailable');
  expect(await absent.credential()).toBeUndefined();
});

it('rejects malformed credentials and suppresses helper diagnostic output', async () => {
  const configured = createGoCaaSUpstream({ GOCAAS_API_KEY: 'bad\ncredential' });
  expect(() => configured.assertReady()).toThrow('GoCaaS credential is invalid');
  expect(await configured.credential()).toBeUndefined();
  const fixture = await helper("process.stderr.write('private-helper-diagnostic'); process.exit(1);");
  expect(await createGoCaaSUpstream({ GOCAAS_API_KEY_HELPER: fixture.file }).credential()).toBeUndefined();
});

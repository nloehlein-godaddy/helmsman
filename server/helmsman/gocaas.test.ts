import { describe, expect, it } from 'vitest';
import { loadGoCaaSConfiguration } from './gocaas';

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

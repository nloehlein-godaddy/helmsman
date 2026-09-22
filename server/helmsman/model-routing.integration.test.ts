import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentTask } from './agents/adapter';
import { createScopedGateway } from './scoped-gateway';
import { buildRoutedAgentCommand } from './model-routing';
import { executePrePrStage } from './pre-pr-runtime';

const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

it.each(['openai-responses', 'anthropic-messages'] as const)('routes direct and staged %s workers through GoCaaS', async transport => {
  vi.stubEnv('GOCAAS_API_KEY', 'must-stay-on-host');
  const fetcher = vi.fn(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  const gateway = createScopedGateway({ modelUpstream: {
    baseUrl: 'https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1', credential: async () => 'fixture-upstream-key',
  }, active: () => true, fetcher });
  const server = gateway.server();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture gateway');
    const task: AgentTask = { ticketId: 'TASK-1', title: 'Fixture', repo: 'owner/repo', jiraBaseUrl: '',
      modelGateway: { url: `http://127.0.0.1:${address.port}`, token: gateway.issue('fixture', 60_000).token } };
    const openai = transport === 'openai-responses';
    const script = `
      if (process.env.GOCAAS_API_KEY) throw new Error('Host credential leaked');
      const url = process.env.${openai ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'} + '${openai ? '/responses' : '/v1/messages'}';
      const response = await fetch(url, {method:'POST', headers:{'content-type':'application/json',
        authorization:'Bearer '+process.env.${openai ? 'OPENAI_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'}}, body:JSON.stringify({model:'fixture-model'})});
      if (!response.ok) throw new Error('Routing failed: '+response.status);
      console.log(JSON.stringify({kind:'result',outcome:'success',text:await response.text()}));`;
    const models = { model: null, effort: null };
    const adapter: AgentAdapter = { id: 'fixture/agent', metadata: {
      version: 1, label: 'Fixture', defaults: models, review: { low: models, medium: models, high: models },
      reviewSkills: [], reviewDelegation: 'none', supportsPrePr: true, docker: transport, costReporting: 'delta',
    }, buildCommand: () => ({ cmd: process.execPath, args: ['--input-type=module', '-e', script] }), parseLine: line => JSON.parse(line) };
    const direct = buildRoutedAgentCommand(adapter, task);
    const result = await exec(direct.cmd, direct.args, { timeout: 10_000 });
    expect(result.stdout).toContain('success');
    for (const stage of ['implement', 'review', 'fix'] as const) {
      const emit = vi.fn();
      await executePrePrStage(adapter, { ...task, prePr: { stage, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/unused' } }, process.cwd(), emit, new AbortController().signal, 10_000);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', outcome: 'success' }));
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe(`https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1/${openai ? 'responses' : 'messages'}`);
      expect(init.headers).toMatchObject(openai ? { Authorization: 'Bearer fixture-upstream-key' } : { 'x-api-key': 'fixture-upstream-key' });
      expect(JSON.stringify(init.headers)).not.toContain(task.modelGateway?.token);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    gateway.close();
  }
}, 30_000);

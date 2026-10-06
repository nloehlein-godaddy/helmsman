/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openProviderSession, providerCommand, type ProviderItem, type ProviderSession } from './provider-session';

const sessions: ProviderSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
const node = (body: string) => ({ cmd: process.execPath, args: ['-e', `
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); ${body} });
`] });
const codex = node(`
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.approvalPolicy !== 'never' || message.params.sandbox !== 'danger-full-access' || message.params.cwd !== process.cwd()) process.exit(9);
    send({ id: message.id, result: { thread: { id: message.method === 'thread/resume' ? message.params.threadId : 'thread-1' } } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-' + message.params.input[0].text } } });
    const notify = (method, params) => send({ method, params: { threadId: message.params.threadId, ...params } });
    notify('item/completed', { item: { id: 'c', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.txt', exitCode: 0 } });
    notify('item/completed', { item: { id: 'm', type: 'agentMessage', text: 'Diagnosis: exec kill' } });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1000000, cachedInputTokens: 0, outputTokens: 0 } } });
    notify('turn/completed', { turn: { id: 'turn-' + message.params.input[0].text, status: message.params.input[0].text === 'fail' ? 'failed' : 'completed', error: { message: 'Provider model failed' } } });
  }
`);
async function open(command: { cmd: string; args: string[] }, extra: Partial<Parameters<typeof openProviderSession>[0]> = {}) {
  const items: ProviderItem[] = [];
  const session = await openProviderSession({ provider: 'codex', command, env: process.env, cwd: process.cwd(), model: 'gpt-6-astra', effort: 'high',
    providerSessionId: null, resume: false, onItem: item => items.push(item), stopGraceMs: 200, ...extra });
  sessions.push(session);
  return { session, items };
}

describe('post-mortem provider session', () => {
  it('starts a codex thread, maps items and prices usage', async () => {
    const f = await open(codex);
    expect(f.session.providerSessionId).toBe('thread-1');
    expect(await f.session.turn('one')).toEqual({ costUsd: 10 });
    expect(f.items).toEqual([{ role: 'agent', kind: 'command', text: '$ ls\na.txt\n(exit 0)' }, { role: 'agent', kind: 'text', text: 'Diagnosis: exec kill' }]);
    await expect(f.session.turn('fail')).rejects.toThrow('Provider model failed');
    await f.session.close();
    expect(await f.session.closed).toBeNull();
  });

  it('resumes a stored codex thread', async () => {
    const f = await open(codex, { providerSessionId: 'thread-9', resume: true });
    expect(f.session.providerSessionId).toBe('thread-9');
    await expect(f.session.turn('two')).resolves.toEqual({ costUsd: 10 });
  });

  it('runs claude turns on the pre-assigned session and reports cumulative cost', async () => {
    const id = randomUUID();
    const claude = node(`
      if (message.session_id !== ${JSON.stringify(id)}) process.exit(9);
      send({ type: 'user', uuid: message.uuid, message: message.message });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
      send({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: message.message.content === 'one' ? 0.12 : 0.3 });
    `);
    const f = await open(claude, { provider: 'claude-code', providerSessionId: id, model: null });
    expect(f.session.providerSessionId).toBe(id);
    expect(await f.session.turn('one')).toEqual({ costUsd: 0.12 });
    expect(await f.session.turn('two')).toEqual({ costUsd: 0.3 });
    expect(f.items.slice(0, 2)).toEqual([{ role: 'agent', kind: 'text', text: 'Looking' }, { role: 'agent', kind: 'tool', text: 'Bash: ls' }]);
  });

  it('reports an unexpected exit and refuses later turns', async () => {
    const f = await open(node(`if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 't' } } }); setTimeout(() => process.exit(3), 20); }`));
    expect((await f.session.closed)?.message).toMatch(/Agent exited 3/);
    await expect(f.session.turn('x')).rejects.toThrow();
  });

  it('escalates to SIGKILL when the provider ignores SIGTERM', async () => {
    const f = await open(node(`if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); send({ id: message.id, result: { thread: { id: 't' } } }); }`));
    const started = Date.now(); await f.session.close();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('builds provider commands with pre-assigned or resumed claude sessions', () => {
    const id = randomUUID();
    expect(providerCommand({ provider: 'claude-code', model: 'opus', effort: 'high', repo: 'org/app', sessionId: id, resume: false }).args.slice(-2)).toEqual(['--session-id', id]);
    expect(providerCommand({ provider: 'claude-code', model: null, effort: null, repo: 'org/app', sessionId: id, resume: true }).args.slice(-2)).toEqual(['--resume', id]);
    expect(providerCommand({ provider: 'codex', model: null, effort: 'high', repo: 'org/app', sessionId: null, resume: false }))
      .toEqual({ cmd: 'codex', args: ['-c', 'model_reasoning_effort="high"', 'app-server', '--stdio'] });
    expect(() => providerCommand({ provider: 'codex', model: null, effort: 'bogus', repo: 'org/app', sessionId: null, resume: false })).toThrow('Unsupported Codex reasoning effort');
  });
});

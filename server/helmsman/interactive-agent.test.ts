// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interactiveAgentCommand, runInteractiveAgent } from './interactive-agent';
import { instructionDirectory, readInstructions, sendInstruction as postInstruction } from './instruction-channel';
import type { AgentTask } from './agents/adapter';
import { codexAgentProvider as codexAdapter } from '../../src/plugins/agent-codex/provider';
import { claudeAgentProvider as claudeCodeAdapter } from '../../src/plugins/agent-claude/provider';
import type { AgentCommandInputV1 } from '../../src/plugins/agent-provider';
import { createScopedGateway } from './scoped-gateway';
import { boundedAgentProvider } from './agent-providers';

const directories: string[] = [];
const agents: AbortController[] = [];
afterEach(async () => {
  for (const abort of agents.splice(0)) abort.abort();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function task(): Promise<AgentTask> {
  const root = await mkdtemp(join(tmpdir(), 'hm-agent-test-'));
  directories.push(root);
  const identity = { runId: 'test-run', attempt: 1, channelId: randomUUID() };
  return { ticketId: 'AB-1', title: 'Test', repo: 'owner/repo', jiraBaseUrl: '', instructions: { ...identity, directory: instructionDirectory(root, identity.runId, identity.attempt, identity.channelId) } };
}

async function target(directory: string) {
  let found: Awaited<ReturnType<typeof readInstructions>> | undefined;
  await vi.waitFor(async () => {
    found = await readInstructions(directory, true);
    expect(found.targets).toHaveLength(1);
  });
  return found!.targets[0]!;
}

async function sendInstruction(directory: string, input: { id: string; targetId: string; text: string }) {
  const receipt = await postInstruction(directory, input);
  if (receipt.status !== 'sending') return receipt;
  let result = receipt;
  await vi.waitFor(async () => {
    result = (await readInstructions(directory, true)).instructions.find(item => item.id === input.id) ?? receipt;
    expect(result.status).not.toBe('sending');
  });
  return result;
}

function fakeCodex(mode = 'success') {
  return { cmd: process.execPath, args: ['-e', `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const notification = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
    const complete = () => {
      notification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 15, cachedInputTokens: 3, outputTokens: 5 }, last: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 } } });
      notification('item/completed', { item: { id: 'item-1', type: 'agentMessage', text: 'Updated implementation' } });
      notification('turn/completed', { turn: { id: 'turn-1', status: '${mode}' === 'turn-failure' ? 'failed' : 'completed', error: { message: 'Provider model failed' } } });
    };
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        if (message.params.approvalPolicy !== 'never' || message.params.sandbox !== 'danger-full-access') process.exit(9);
        send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      }
      if (['turn/start', 'turn/steer'].includes(message.method) && !Array.isArray(message.params.input[0].text_elements)) process.exit(10);
      if (message.method === 'turn/start') send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      if (message.method === 'turn/steer') {
        if (message.params.expectedTurnId !== 'turn-1' || message.params.threadId !== 'thread-1' || !message.params.clientUserMessageId) process.exit(8);
        if ('${mode}' === 'disconnect') return process.exit(1);
        if ('${mode}' === 'timeout') return setTimeout(complete, 150);
        if ('${mode}' === 'completion-race') complete();
        setTimeout(() => {
          send('${mode}' === 'rejected' ? { id: message.id, error: { message: 'This turn has already finished' } }
            : { id: message.id, result: { turnId: 'turn-1' } });
          if ('${mode}' !== 'completion-race') setTimeout(complete, 30);
        }, 100);
      }
    });
  `] };
}

function run(task: AgentTask, provider: 'codex' | 'claude-code', command: { cmd: string; args: string[] }, timeout?: number) {
  const abort = new AbortController(); agents.push(abort);
  const output: string[] = [];
  const protocol = provider === 'codex' ? 'codex-app-server' : 'claude-stream-json';
  const promise = runInteractiveAgent({ instructions: task.instructions!, provider: 'fixture/' + provider, stage: `${task.prePr?.stage ?? 'implement'}${task.prePr?.round ? ` · round ${task.prePr.round}` : ''}`,
    interactive: { command, protocol, initialInput: { prompt: 'Retained fixture prompt', model: null, effort: null } }, transport: null, skillsPath: null }, { output: line => output.push(line), diagnostic: () => {}, signal: abort.signal, instructionTimeoutMs: timeout });
  void promise.catch(() => {});
  return { promise, output, abort };
}

describe('interactive agent provider transport', () => {
  it.each(['codex', 'claude'] as const)('routes the actual %s child through the scoped gateway with pinned protocol settings', async name => {
    const input = await task();
    const root = await mkdtemp(join(tmpdir(), 'hm-interactive-binary-')); directories.push(root);
    const binary = join(root, name);
    vi.stubEnv('GOCAAS_API_KEY', 'host-secret'); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'direct-oauth');
    const fetcher = vi.fn(async () => new Response('{"ok":true}'));
    const gateway = createScopedGateway({ active: () => true, fetcher, modelUpstream: { baseUrl: 'https://upstream.example/v1', credential: async () => 'upstream-token' } });
    const server = gateway.server();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway did not start');
    const abort = new AbortController(); agents.push(abort);
    try {
      const codex = name === 'codex';
      const protocol = codex ? 'codex-app-server' : 'claude-stream-json';
      const script = codex ? fakeCodex().args[1]! : `
        const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
        require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
          await ready;
          const message=JSON.parse(line);
          if (message.session_id === '') send({type:'system',subtype:'init',session_id:'claude-1'});
          else { send({type:'user',uuid:message.uuid}); send({type:'result',subtype:'success',result:'done'}); }
        });`;
      const check = `
        if(process.env.GOCAAS_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('Direct credential leaked');
        const fs = require('node:fs');
        const argv = process.argv.slice(2);
        if (${codex} && (!argv.includes('app-server') || !argv.includes('model_provider="helmsman"'))) throw new Error('Codex route missing');
        if (!${codex} && (!argv.includes('--replay-user-messages') || !argv.includes('--settings') || !fs.existsSync(argv[argv.indexOf('--settings')+1]))) throw new Error('Claude route missing');
        const ready = fetch(process.env.${codex ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'}+'${codex ? '/responses' : '/v1/messages'}',
          {method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.${codex ? 'OPENAI_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'}},body:JSON.stringify({model:'pinned-model'})})
          .then(response=>{if(!response.ok)throw new Error('Model routing failed');});
        ready.catch(()=>process.exit(9));`;
      await writeFile(binary, `#!${process.execPath}\n${check}\n${script}`, { mode: 0o700 });
      const provider = codex ? codexAdapter : claudeCodeAdapter;
      const interactive = provider.buildInteractiveCommand!({ version: 1, prompt: 'Pinned workflow prompt', model: 'pinned-model', effort: 'high', stage: 'direct', summaryCorrection: false,
        task: { ticketId: input.ticketId, repo: input.repo, title: input.title } });
      const promise = runInteractiveAgent({ provider: `fixture/${name}`, stage: 'implement', instructions: input.instructions!,
        interactive: { ...interactive, command: { ...interactive.command, cmd: binary }, protocol }, transport: codex ? 'openai-responses' : 'anthropic-messages',
        modelGateway: { url: `http://127.0.0.1:${address.port}/`, token: gateway.issue('fixture', 60_000).token }, skillsPath: null },
      { signal: abort.signal, output: () => {}, diagnostic: () => {} });
      void promise.catch(() => {});
      const endpoint = await target(input.instructions!.directory);
      expect((await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Apply this update' })).status).toBe('delivered');
      await promise;
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]).toEqual([`https://upstream.example/v1/${codex ? 'responses' : 'messages'}`, expect.objectContaining({
        headers: expect.objectContaining(codex ? { Authorization: 'Bearer upstream-token' } : { 'x-api-key': 'upstream-token' }),
      })]);
    } finally {
      abort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); gateway.close();
    }
  });

  it('waits for Codex steer acknowledgment, preserves stage identity, and maps output/usage', async () => {
    const input = await task();
    input.prePr = { stage: 'fix', round: 2, baseSha: 'a', reportPath: '/tmp/report' };
    const agent = run(input, 'codex', fakeCodex());
    const endpoint = await target(input.instructions!.directory);
    expect(endpoint).toMatchObject({ provider: 'fixture/codex', stage: 'fix · round 2' });
    let acknowledged = false;
    const delivery = sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Keep the existing API' })
      .then(result => { acknowledged = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(acknowledged).toBe(false);
    expect((await delivery).status).toBe('delivered');
    await agent.promise;
    expect(agent.output.map(line => codexAdapter.parseLine(line))).toContainEqual({ kind: 'result', outcome: 'unknown', text: 'Updated implementation', eventId: 'item-1' });
    expect(agent.output.map(line => codexAdapter.parseLine(line))).toContainEqual({ kind: 'usage', provider: 'codex', text: 'Codex turn completed', eventId: 'turn-1', usage: { inputTokens: 15, cachedInputTokens: 3, outputTokens: 5 } });
    expect((await readInstructions(input.instructions!.directory, true)).targets).toHaveLength(0);
    await expect(sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Too late' })).rejects.toThrow('finished');
  });

  it('records provider rejections without claiming delivery or failing an otherwise completed voyage', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex('rejected'));
    const endpoint = await target(input.instructions!.directory);
    expect(await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Late instruction' }))
      .toMatchObject({ status: 'failed', error: 'This turn has already finished' });
    await agent.promise;
  });

  it('settles an in-flight steer acknowledgment even if completion arrives first', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex('completion-race'));
    const endpoint = await target(input.instructions!.directory);
    expect((await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Last instruction' })).status).toBe('delivered');
    await agent.promise;
  });

  it.each(['disconnect', 'timeout'])('records uncertain delivery after %s', async mode => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex(mode), 80);
    const endpoint = await target(input.instructions!.directory);
    expect((await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Uncertain instruction' })).status).toBe('unknown');
    if (mode === 'disconnect') await expect(agent.promise).rejects.toThrow('Agent exited');
    else await agent.promise;
  });

  it('requires Claude replay acknowledgment and drains a submitted instruction after the first result', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      const readline = require('node:readline');
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      let inputs = 0;
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (++inputs === 1) return send({ type: 'system', subtype: 'init', session_id: 'claude-1' });
        if (message.session_id !== 'claude-1') return process.exit(9);
        send({ type: 'result', subtype: 'success', result: 'Initial work complete', total_cost_usd: 0.01 });
        setTimeout(() => {
          send({ type: 'user', uuid: message.uuid, message: message.message });
          setTimeout(() => {
            send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Instruction applied' }] } });
            send({ type: 'result', subtype: 'success', result: 'Follow-up complete', total_cost_usd: 0.02 });
          }, 5200);
        }, 100);
      });
    `] }, 25);
    const endpoint = await target(input.instructions!.directory);
    let acknowledged = false;
    const delivery = sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Also fix the label' })
      .then(result => { acknowledged = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(acknowledged).toBe(false);
    expect((await delivery).status).toBe('delivered');
    await agent.promise;
    expect(agent.output.map(line => claudeCodeAdapter.parseLine(line))).toContainEqual(expect.objectContaining({ kind: 'log', text: 'Instruction applied' }));
    expect(agent.output.map(line => JSON.parse(line)).filter(line => line.type === 'result'))
      .toEqual([expect.objectContaining({ result: 'Follow-up complete', total_cost_usd: 0.02 })]);
  }, 10_000);

  it('stops the provider and closes instruction targets when aborted', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex());
    await target(input.instructions!.directory);
    agent.abort.abort();
    await expect(agent.promise).rejects.toThrow('Voyage stopped');
    expect((await readInstructions(input.instructions!.directory, true)).targets).toHaveLength(0);
  });

  it('keeps Claude follow-up work steerable across intermediate results', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      let inputs = 0;
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (++inputs === 1) return send({ type: 'system', subtype: 'init', session_id: 'claude-1' });
        send({ type: 'result', subtype: 'success', result: 'Prior work complete', total_cost_usd: 0.01 * inputs });
        setTimeout(() => {
          send({ type: 'user', uuid: message.uuid, message: message.message });
          if (inputs === 3) setTimeout(() => send({ type: 'result', subtype: 'success', result: 'Both instructions applied', total_cost_usd: 0.04 }), 50);
        }, 100);
      });
    `] }, 25);
    const endpoint = await target(input.instructions!.directory);
    expect((await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'First instruction' })).status).toBe('delivered');
    expect((await readInstructions(input.instructions!.directory, true)).targets).toContainEqual(endpoint);
    expect((await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Second instruction' })).status).toBe('delivered');
    await agent.promise;
    expect(agent.output.map(line => JSON.parse(line)).filter(line => line.type === 'result'))
      .toEqual([expect.objectContaining({ result: 'Both instructions applied', total_cost_usd: 0.04 })]);
  });

  it('marks a queued Claude instruction unknown when the agent exits before replaying it', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      let inputs = 0;
      require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
        if (++inputs === 1) process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-1' }) + '\\n');
        else {
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Initial task complete' }) + '\\n');
          setTimeout(() => process.exit(0), 25);
        }
      });
    `] }, 25);
    const endpoint = await target(input.instructions!.directory);
    expect((await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Queued instruction' })).status).toBe('unknown');
    await expect(agent.promise).rejects.toThrow('Agent exited');
  });

  it('fails when Codex reports an unsuccessful turn even if its process exits zero', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex('turn-failure'));
    const endpoint = await target(input.instructions!.directory);
    await sendInstruction(input.instructions!.directory, { id: randomUUID(), targetId: endpoint.id, text: 'Continue' });
    await expect(agent.promise).rejects.toThrow('Provider model failed');
    expect(agent.output.map(line => codexAdapter.parseLine(line))).toContainEqual({ kind: 'result', outcome: 'failure', text: 'Provider model failed', eventId: 'turn-1' });
  });

  it('fails when Claude reports an error result even if its process exits zero', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }) + '\\n');
      });
    `] });
    await expect(agent.promise).rejects.toThrow('unsuccessful result');
  });

  it('preserves retained Unicode prompts across short prefixed launcher arguments', async () => {
    const input = await task();
    const commandInput: AgentCommandInputV1 = { version: 1, prompt: `${'😀'.repeat(500)}\nquoted "text" \\`, model: null, effort: null,
      stage: 'direct', summaryCorrection: false, task: { ticketId: input.ticketId, repo: input.repo, title: input.title } };
    const interactive = codexAdapter.buildInteractiveCommand!(commandInput);
    const command = interactiveAgentCommand(input, 'example/agent', interactive, 'openai-responses');
    const args = command.args.slice(command.args.findIndex(argument => /interactive-agent-cli\.[jt]s$/.test(argument)) + 1);
    expect(args.every(chunk => chunk.length <= 256 && chunk.startsWith('--input='))).toBe(true);
    expect(JSON.parse(args.map(chunk => Buffer.from(chunk).toString().slice('--input='.length)).join('')))
      .toMatchObject({ interactive, instructions: input.instructions, provider: 'example/agent' });
  });
});

function codexScript(body: string) {
  return { cmd: process.execPath, args: ['-e', `
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      ${body}
    });
  `] };
}

describe('interactive agent protocol characterization', () => {
  it('rejects provider-initiated Codex requests, ignores foreign threads and maps command items', async () => {
    const input = await task();
    const agent = run(input, 'codex', codexScript(`
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });
      }
      if (message.id === 'server-1') {
        if (message.error?.code !== -32601) process.exit(7);
        send({ method: 'item/started', params: { threadId: 'thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', status: 'inProgress' } } });
        send({ method: 'item/completed', params: { threadId: 'other-thread', item: { id: 'x', type: 'agentMessage', text: 'Foreign' } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a', exitCode: 0, status: 'completed' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      }
    `));
    await agent.promise;
    expect(agent.output.map(line => JSON.parse(line))).toEqual([
      { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', status: 'inProgress' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' } },
      { type: 'turn.completed', turn_id: 'turn-1' },
    ]);
  });

  it('keeps large command output out of the bounded agent event stream', async () => {
    const agent = run(await task(), 'codex', codexScript(`
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test', aggregatedOutput: '\\n'.repeat(600_000), exitCode: 0, status: 'completed' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      }
    `));
    await agent.promise;
    const provider = boundedAgentProvider(codexAdapter);
    expect(agent.output.map(line => provider.parseLine(line))).toEqual([
      { kind: 'tool', text: 'pnpm test', eventId: 'cmd-1' },
      { kind: 'log', text: JSON.stringify({ type: 'turn.completed', turn_id: 'turn-1' }) },
    ]);
  });

  it('fails on a non-object protocol line', async () => {
    const agent = run(await task(), 'codex', codexScript(`if (message.method === 'initialize') process.stdout.write('[1]\\n');`));
    await expect(agent.promise).rejects.toThrow('Malformed agent protocol output');
  });

  it('fails on an unparseable protocol line', async () => {
    const agent = run(await task(), 'codex', codexScript(`if (message.method === 'initialize') process.stdout.write('{\\n');`));
    await expect(agent.promise).rejects.toBeInstanceOf(SyntaxError);
  });

  it('fails when unterminated protocol output exceeds 8 MB', async () => {
    const agent = run(await task(), 'codex', codexScript(`if (message.method === 'initialize') process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));`));
    await expect(agent.promise).rejects.toThrow('Agent protocol output exceeded its limit');
  });

  it('times out an unanswered protocol request', async () => {
    const input = await task();
    const abort = new AbortController(); agents.push(abort);
    const promise = runInteractiveAgent({ instructions: input.instructions!, provider: 'fixture/codex', stage: 'implement',
      interactive: { command: codexScript(''), protocol: 'codex-app-server', initialInput: { prompt: 'p', model: null, effort: null } }, transport: null, skillsPath: null },
    { output: () => {}, diagnostic: () => {}, signal: abort.signal, requestTimeoutMs: 50 });
    await expect(promise).rejects.toThrow('Agent protocol request timed out');
  });
});

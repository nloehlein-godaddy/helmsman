import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentTask } from './agents/adapter';
import { parseAgentInteractiveCommandV1, type AgentInteractiveCommandV1 } from '../../src/plugins/agent-provider';
import { runtimeNodeArguments, chunkInputArguments } from './runtime-paths';
import { prepareModelRouting } from './model-routing-cli';
import { assertInstructionChannel, startInstructionEndpoint, InstructionDeliveryUnknownError, type InstructionIdentity } from './instruction-channel';
import { connectAgentProtocol, type ProtocolTimeout } from './agent-protocol';

export interface InteractiveAgentConfig {
  provider: string;
  stage: string;
  instructions: InstructionIdentity & { directory: string };
  interactive: AgentInteractiveCommandV1;
  transport: 'openai-responses' | 'anthropic-messages' | null;
  modelGateway?: { url: string; token: string };
  skillsPath: string | null;
}

export function interactiveAgentCommand(task: AgentTask, provider: string, interactive: AgentInteractiveCommandV1,
  transport: InteractiveAgentConfig['transport']): { cmd: string; args: string[] } {
  if (!task.instructions) throw new Error('Interactive agent requires an instruction channel');
  const stage = `${task.feedbackStage?.stage ?? task.prePr?.stage ?? (task.review ? 'review' : 'implement')}${task.prePr?.round === undefined ? '' : ` · round ${task.prePr.round}`}`;
  const config: InteractiveAgentConfig = { provider, stage, instructions: task.instructions, interactive, transport,
    ...(task.modelGateway ? { modelGateway: task.modelGateway } : {}), skillsPath: task.skillsPath ?? null };
  const chunks = chunkInputArguments(JSON.stringify(config));
  return { cmd: process.execPath, args: [...runtimeNodeArguments('./interactive-agent-cli.ts', import.meta.url), ...chunks] };
}

export function parseInteractiveAgentConfig(value: unknown): InteractiveAgentConfig {
  const config = record(value); const instructions = record(config?.instructions); const gateway = record(config?.modelGateway);
  if (!config || typeof config.provider !== 'string' || !config.provider.trim() || typeof config.stage !== 'string' || !config.stage.trim()
    || !instructions || typeof instructions.directory !== 'string' || typeof instructions.runId !== 'string'
    || !Number.isSafeInteger(instructions.attempt) || Number(instructions.attempt) < 1 || typeof instructions.channelId !== 'string'
    || ![null, 'openai-responses', 'anthropic-messages'].includes(config.transport as string | null)
    || config.skillsPath !== null && typeof config.skillsPath !== 'string'
    || config.modelGateway !== undefined && (!gateway || typeof gateway.url !== 'string' || typeof gateway.token !== 'string')) throw new Error('Invalid interactive agent invocation');
  const interactive = parseAgentInteractiveCommandV1(config.interactive);
  if (config.modelGateway && config.transport !== (interactive.protocol === 'codex-app-server' ? 'openai-responses' : 'anthropic-messages')) throw new Error('Interactive protocol does not match the scoped model transport');
  return { provider: config.provider, stage: config.stage, instructions: { directory: instructions.directory, runId: instructions.runId,
    attempt: Number(instructions.attempt), channelId: instructions.channelId }, interactive, transport: config.transport as InteractiveAgentConfig['transport'],
    ...(gateway ? { modelGateway: { url: String(gateway.url), token: String(gateway.token) } } : {}), skillsPath: config.skillsPath as string | null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function runInteractiveAgent(config: InteractiveAgentConfig, options: {
  output?: (line: string) => void;
  diagnostic?: (line: string) => void;
  requestTimeoutMs?: number;
  instructionTimeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const parsed = parseInteractiveAgentConfig(config);
  const { provider, instructions, interactive, stage } = parsed;
  assertInstructionChannel(instructions);
  const { protocol, initialInput } = interactive;
  const routed = parsed.modelGateway ? await prepareModelRouting({ version: 1, command: interactive.command, transport: parsed.transport,
    modelGateway: parsed.modelGateway, skillsPath: parsed.skillsPath }) : null;
  const command = routed?.command ?? interactive.command;
  const output = options.output ?? (line => process.stdout.write(`${line}\n`));
  const diagnostic = options.diagnostic ?? (line => process.stderr.write(line));
  const emit = (value: unknown) => output(JSON.stringify(value));
  const child = spawn(command.cmd, command.args, { env: routed?.environment ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const connection = connectAgentProtocol(child, { protocol,
    onMessage: message => { if (protocol === 'codex-app-server') codexMessage(message); else claudeMessage(message); },
    onFailure: error => stop(error) });
  let endpoint: Awaited<ReturnType<typeof startInstructionEndpoint>> | undefined;
  let endpointStarting: Promise<void> | undefined;
  let active = false;
  let completed = false;
  let closing = false;
  let failure: Error | undefined;
  let threadId = '';
  let turnId = '';
  let lastUsage: unknown;
  let claudeResult: Record<string, unknown> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const timeout = (instruction: boolean): ProtocolTimeout | null => protocol === 'claude-stream-json' && instruction ? null : {
    ms: (instruction ? options.instructionTimeoutMs : undefined) ?? options.requestTimeoutMs ?? 20_000,
    error: () => instruction ? new InstructionDeliveryUnknownError('Agent did not acknowledge the instruction in time') : new Error('Agent protocol request timed out'),
  };
  const stop = (error: Error) => {
    failure ??= error;
    active = false;
    connection.rejectPending(new InstructionDeliveryUnknownError('Agent disconnected before acknowledging the instruction'));
    child.kill('SIGTERM');
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    stopTimer.unref();
  };
  const openEndpoint = (): Promise<void> => endpointStarting ??= (async () => {
    if (!active || closing) return;
    endpoint = await startInstructionEndpoint({ ...instructions, provider, protocol, stage }, async (text, id) => {
      if (!active || closing) throw new Error('Agent has finished this stage');
      if (protocol === 'codex-app-server') {
        const expectedTurnId = turnId;
        const response = record(await connection.rpc('turn/steer', { threadId, expectedTurnId, clientUserMessageId: id,
          input: [{ type: 'text', text, text_elements: [] }] }, timeout(true)));
        if (response?.turnId !== expectedTurnId) throw new InstructionDeliveryUnknownError('Agent returned an unexpected turn acknowledgment');
      } else {
        await connection.request(id, { type: 'user', uuid: id, session_id: threadId, message: { role: 'user', content: text }, parent_tool_use_id: null }, timeout(true));
      }
    });
    if (!active || closing) await endpoint.close();
  })();
  const finish = () => {
    if (closing) return;
    closing = true;
    active = false;
    void (async () => {
      await endpointStarting;
      const close = endpoint?.close();
      if (protocol === 'claude-stream-json') child.stdin.end();
      await close;
      if (protocol !== 'codex-app-server') return;
      child.stdin.end();
      stopTimer ??= setTimeout(() => {
        stopTimer = undefined;
        if (protocol === 'codex-app-server' && completed && !failure) {
          child.kill('SIGTERM');
          stopTimer = setTimeout(() => stop(new Error('Agent failed to shut down')), 5000);
          stopTimer.unref();
        }
        else stop(new Error('Agent did not finish after its final result'));
      }, 5000);
      stopTimer.unref();
    })().catch(error => stop(error instanceof Error ? error : new Error(String(error))));
  };
  const codexMessage = (message: Record<string, unknown>) => {
    const params = record(message.params);
    if (!params || params.threadId !== threadId) return;
    if (message.method === 'thread/tokenUsage/updated') lastUsage = record(params.tokenUsage)?.total;
    if (message.method === 'item/completed' || message.method === 'item/started') {
      const item = record(params.item);
      const type = message.method === 'item/completed' ? 'item.completed' : 'item.started';
      if (item?.type === 'agentMessage' && type === 'item.completed') emit({ type, item: { id: item.id, type: 'agent_message', text: item.text } });
      if (item?.type === 'commandExecution') emit({ type, item: { id: item.id, type: 'command_execution', command: item.command,
        exit_code: item.exitCode, status: item.status } });
    }
    if (message.method === 'error') {
      const error = record(params.error);
      if (params.willRetry !== true) failure ??= new Error(typeof error?.message === 'string' ? error.message : 'Agent reported an error');
      diagnostic(`${typeof error?.message === 'string' ? error.message : 'Agent reported an error'}\n`);
    }
    if (message.method === 'turn/completed') {
      const turn = record(params.turn);
      if (turn?.id !== turnId && turnId) return;
      completed = turn?.status === 'completed';
      if (!completed) failure ??= new Error(typeof record(turn?.error)?.message === 'string' ? String(record(turn?.error)?.message) : `Agent turn ${String(turn?.status ?? 'failed')}`);
      emit({ type: completed ? 'turn.completed' : 'turn.failed', turn_id: turn?.id, usage: lastUsage,
        ...(failure ? { error: { message: failure.message } } : {}) });
      finish();
    }
  };
  const claudeMessage = (message: Record<string, unknown>) => {
    if (message.type !== 'result') output(JSON.stringify(message));
    if (message.type === 'system' && message.subtype === 'init') {
      threadId = typeof message.session_id === 'string' ? message.session_id : '';
      if (!closing) { active = true; void openEndpoint().catch(error => stop(error)); }
    }
    if (message.type === 'result') {
      claudeResult = message;
      if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error'))) failure ??= new Error('Agent reported an unsuccessful result');
      completed = !failure && connection.pendingCount() === 0;
      if (failure || connection.pendingCount() === 0) finish();
    }
  };
  child.stderr.setEncoding('utf8').on('data', diagnostic);
  child.stdin.on('error', error => {
    connection.rejectPending(new InstructionDeliveryUnknownError('Agent input disconnected before acknowledging the instruction'));
    if (!closing) stop(error);
  });
  child.once('error', error => stop(error));
  child.once('close', (code, signal) => {
    active = false;
    if (stopTimer) clearTimeout(stopTimer);
    if (!completed || code !== 0 && !(protocol === 'codex-app-server' && closing && signal === 'SIGTERM')) failure ??= new Error(`Agent exited ${signal ?? code} before successful completion`);
    if (claudeResult) emit(claudeResult);
    connection.rejectPending(new InstructionDeliveryUnknownError('Agent exited before acknowledging the instruction'));
    resolveExit();
  });
  const abort = () => stop(new Error('Voyage stopped'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    else if (protocol === 'codex-app-server') {
      await connection.rpc('initialize', { clientInfo: { name: 'helmsman', version: '0.4.0' }, capabilities: {} }, timeout(false));
      connection.write({ method: 'initialized' });
      const { model, effort } = initialInput;
      const result = record(await connection.rpc('thread/start', { cwd: process.cwd(), model, approvalPolicy: 'never', sandbox: 'danger-full-access' }, timeout(false)));
      const thread = record(result?.thread);
      if (typeof thread?.id !== 'string') throw new Error('Agent returned no thread ID');
      threadId = thread.id;
      const started = record(await connection.rpc('turn/start', { threadId, input: [{ type: 'text', text: initialInput.prompt, text_elements: [] }], effort }, timeout(false)));
      const turn = record(started?.turn);
      if (typeof turn?.id !== 'string') throw new Error('Agent returned no turn ID');
      turnId = turn.id;
      if (!closing) { active = true; await openEndpoint(); }
    } else {
      connection.write({ type: 'user', uuid: randomUUID(), session_id: '', message: { role: 'user', content: initialInput.prompt }, parent_tool_use_id: null });
    }
    await exited;
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
    await exited;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { await endpointStarting; await endpoint?.close(); } finally { await routed?.cleanup(); }
  }
  if (failure) throw failure;
}

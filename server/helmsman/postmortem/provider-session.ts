import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { claudeAgentProvider } from '../../../src/plugins/agent-claude/provider';
import { codexAgentProvider } from '../../../src/plugins/agent-codex/provider';
import { connectAgentProtocol, protocolRecord, type ProtocolRecord, type ProtocolTimeout } from '../agent-protocol';
import { estimateUnreportedUsage } from '../cost-estimates';
import type { PostmortemKind, PostmortemProvider } from './session-store';

export interface ProviderItem { role: 'agent' | 'system'; kind: PostmortemKind; text: string }
export interface ProviderSession {
  readonly providerSessionId: string;
  turn(text: string): Promise<{ costUsd: number | null }>;
  close(): Promise<void>;
  readonly closed: Promise<Error | null>;
}
export interface OpenProviderSessionInput {
  provider: PostmortemProvider; command: { cmd: string; args: readonly string[] }; env: NodeJS.ProcessEnv; cwd: string;
  model: string | null; effort: string | null; providerSessionId: string | null; resume: boolean;
  onItem(item: ProviderItem): void; requestTimeoutMs?: number; stopGraceMs?: number;
}
const CODEX_DEFAULT_MODEL = 'gpt-6-astra';
const COMMAND_OUTPUT_CHARS = 4000;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function providerTransport(provider: PostmortemProvider): 'openai-responses' | 'anthropic-messages' {
  return provider === 'codex' ? 'openai-responses' : 'anthropic-messages';
}

export function providerCommand(input: { provider: PostmortemProvider; model: string | null; effort: string | null; repo: string; sessionId: string | null; resume: boolean }): { cmd: string; args: string[] } {
  const request = { version: 1 as const, prompt: 'Failure post-mortem', model: input.model, effort: input.effort, stage: 'direct' as const, summaryCorrection: false,
    task: { ticketId: 'postmortem', repo: input.repo, title: 'Failure post-mortem' } };
  if (input.provider === 'codex') {
    const interactive = codexAgentProvider.buildInteractiveCommand!(request);
    return { cmd: interactive.command.cmd, args: [...interactive.command.args] };
  }
  if (!input.sessionId) throw new Error('Claude post-mortem requires a session ID');
  const interactive = claudeAgentProvider.buildInteractiveCommand!(request);
  return { cmd: interactive.command.cmd, args: [...interactive.command.args, input.resume ? '--resume' : '--session-id', input.sessionId] };
}

function commandText(item: ProtocolRecord): string {
  return [`$ ${String(item.command)}`, typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(-COMMAND_OUTPUT_CHARS) : '',
    typeof item.exitCode === 'number' ? `(exit ${item.exitCode})` : ''].filter(Boolean).join('\n');
}

export async function openProviderSession(input: OpenProviderSessionInput): Promise<ProviderSession> {
  const protocol = input.provider === 'codex' ? 'codex-app-server' : 'claude-stream-json';
  const model = input.provider === 'codex' ? input.model ?? CODEX_DEFAULT_MODEL : input.model;
  const timeout: ProtocolTimeout = { ms: input.requestTimeoutMs ?? 20_000, error: () => new Error('Agent protocol request timed out') };
  const child = spawn(input.command.cmd, [...input.command.args], { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let current: { resolve(value: { costUsd: number | null }): void; reject(error: Error): void; turnId: string } | null = null;
  let threadId = input.provider === 'codex' ? '' : input.providerSessionId ?? '';
  let usage: ProtocolRecord | undefined;
  let claudeCost: number | null = null;
  let turnError: Error | null = null;
  let failure: Error | null = null;
  let closing = false;
  let exited = false;
  let stderr = '';
  let closingPromise: Promise<void> | undefined;
  let resolveClosed!: (error: Error | null) => void;
  const closed = new Promise<Error | null>(resolve => { resolveClosed = resolve; });
  const codexCost = () => usage ? estimateUnreportedUsage({ runId: 'postmortem', attempt: 1, eventId: 'postmortem', provider: 'codex', model,
    inputTokens: count(usage.inputTokens), cachedInputTokens: count(usage.cachedInputTokens), outputTokens: count(usage.outputTokens), totalTokens: null, costUsd: null }) : null;
  const settle = (error: Error | null, value?: { costUsd: number | null }) => {
    const turn = current; current = null;
    if (!turn) return;
    if (error) turn.reject(error); else turn.resolve(value ?? { costUsd: null });
  };
  const fail = (error: Error) => {
    failure ??= error;
    settle(error);
    if (!exited) child.kill('SIGTERM');
  };
  const codexMessage = (message: ProtocolRecord) => {
    const params = protocolRecord(message.params);
    if (!params || params.threadId !== threadId) return;
    const item = protocolRecord(params.item);
    if (message.method === 'thread/tokenUsage/updated') usage = protocolRecord(protocolRecord(params.tokenUsage)?.total);
    if (message.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) input.onItem({ role: 'agent', kind: 'text', text: item.text });
    if (message.method === 'item/completed' && item?.type === 'commandExecution' && typeof item.command === 'string') input.onItem({ role: 'agent', kind: 'command', text: commandText(item) });
    if (message.method === 'error') {
      const error = protocolRecord(params.error); const text = typeof error?.message === 'string' ? error.message : 'Agent reported an error';
      input.onItem({ role: 'system', kind: 'error', text });
      if (params.willRetry !== true) turnError ??= new Error(text);
    }
    if (message.method === 'turn/completed') {
      const turn = protocolRecord(params.turn);
      if (!current || current.turnId && turn?.id !== current.turnId) return;
      const error = turn?.status === 'completed' && !turnError ? null : turnError
        ?? new Error(typeof protocolRecord(turn?.error)?.message === 'string' ? String(protocolRecord(turn?.error)?.message) : `Agent turn ${String(turn?.status ?? 'failed')}`);
      turnError = null;
      settle(error, { costUsd: codexCost() });
    }
  };
  const claudeMessage = (message: ProtocolRecord) => {
    if (message.type === 'assistant') {
      const content = protocolRecord(message.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const item = protocolRecord(block);
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) input.onItem({ role: 'agent', kind: 'text', text: item.text.trim() });
        if (item?.type === 'tool_use' && typeof item.name === 'string') {
          const args = protocolRecord(item.input);
          const detail = typeof args?.command === 'string' ? args.command : typeof args?.file_path === 'string' ? args.file_path : '';
          input.onItem({ role: 'agent', kind: 'tool', text: detail ? `${item.name}: ${detail}` : item.name });
        }
      }
    }
    if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd) && message.total_cost_usd >= 0) claudeCost = message.total_cost_usd;
      const failed = message.is_error === true || typeof message.subtype === 'string' && message.subtype.startsWith('error');
      settle(failed ? new Error(typeof message.result === 'string' && message.result ? message.result : 'Agent reported an unsuccessful result') : null, { costUsd: claudeCost });
    }
  };
  const connection = connectAgentProtocol(child, { protocol, onFailure: fail,
    onMessage: message => { if (protocol === 'codex-app-server') codexMessage(message); else claudeMessage(message); } });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.stdin.on('error', error => { if (!closing) fail(error); });
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    const detail = stderr.trim().split('\n').pop();
    const error = closing ? null : failure ?? new Error(`Agent exited ${signal ?? code}${detail ? `: ${detail}` : ''}`);
    connection.rejectPending(error ?? new Error('Agent stopped'));
    settle(error ?? new Error('Agent stopped'));
    resolveClosed(error);
  };
  child.once('error', error => { fail(error); if (child.pid === undefined) finish(null, null); });
  child.once('close', finish);
  const session: ProviderSession = {
    get providerSessionId() { return threadId; },
    closed,
    turn(text) {
      if (current) return Promise.reject(new Error('A turn is already in progress'));
      if (exited || failure) return Promise.reject(failure ?? new Error('Agent connection is closed'));
      return new Promise((resolve, reject) => {
        const turn = { resolve, reject, turnId: '' }; current = turn;
        if (protocol === 'codex-app-server') {
          connection.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(input.effort ? { effort: input.effort } : {}) }, timeout)
            .then(result => { const id = protocolRecord(protocolRecord(result)?.turn)?.id; if (typeof id !== 'string') throw new Error('Agent returned no turn ID'); turn.turnId = id; })
            .catch(error => fail(asError(error)));
        } else {
          try { connection.write({ type: 'user', uuid: randomUUID(), session_id: threadId, message: { role: 'user', content: text }, parent_tool_use_id: null }); }
          catch (error) { fail(asError(error)); }
        }
      });
    },
    close() {
      closingPromise ??= (async () => {
        closing = true;
        if (exited) return;
        child.stdin.end();
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), input.stopGraceMs ?? 5000); timer.unref();
        await closed; clearTimeout(timer);
      })();
      return closingPromise;
    },
  };
  if (protocol === 'codex-app-server') {
    try {
      await connection.rpc('initialize', { clientInfo: { name: 'helmsman', version: '0.4.0' }, capabilities: {} }, timeout);
      connection.write({ method: 'initialized' });
      if (input.resume && !input.providerSessionId) throw new Error('No stored thread to resume');
      const params = { cwd: input.cwd, model, approvalPolicy: 'never', sandbox: 'danger-full-access' };
      const result = protocolRecord(await connection.rpc(input.resume ? 'thread/resume' : 'thread/start', input.resume ? { threadId: input.providerSessionId, ...params } : params, timeout));
      const id = protocolRecord(result?.thread)?.id;
      if (typeof id !== 'string' || input.resume && id !== input.providerSessionId) throw new Error('Agent returned no thread ID');
      threadId = id;
    } catch (error) {
      fail(asError(error));
      await closed;
      throw failure ?? asError(error);
    }
  }
  return session;
}

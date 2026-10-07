import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type AgentProtocol = 'codex-app-server' | 'claude-stream-json';
export type ProtocolRecord = Record<string, unknown>;
export interface ProtocolTimeout { readonly ms: number; readonly error: () => Error }
export interface AgentProtocolConnection {
  write(value: unknown): void;
  request(id: string, value: unknown, timeout: ProtocolTimeout | null): Promise<unknown>;
  rpc(method: string, params: unknown, timeout: ProtocolTimeout | null, id?: string): Promise<unknown>;
  rejectPending(error: Error): void;
  pendingCount(): number;
}
export const AGENT_PROTOCOL_BUFFER_LIMIT = 8 * 1024 * 1024;

export function protocolRecord(value: unknown): ProtocolRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolRecord : undefined;
}

export function connectAgentProtocol(child: ChildProcessWithoutNullStreams, options: {
  protocol: AgentProtocol; onMessage(message: ProtocolRecord): void; onFailure(error: Error): void;
}): AgentProtocolConnection {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  let buffer = '';
  const write = (value: unknown) => {
    if (child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) throw new Error('Agent connection is closed');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const settle = (id: string, result: unknown, error?: Error) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(id);
    if (error) entry.reject(error); else entry.resolve(result);
  };
  const request = (id: string, value: unknown, timeout: ProtocolTimeout | null): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = timeout ? setTimeout(() => { pending.delete(id); reject(timeout.error()); }, timeout.ms) : undefined;
    pending.set(id, { resolve, reject, timer });
    try { write(value); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const dispatch = (message: ProtocolRecord) => {
    if (options.protocol === 'claude-stream-json') {
      options.onMessage(message);
      if (message.type === 'user' && typeof message.uuid === 'string') settle(message.uuid, message);
      return;
    }
    if (typeof message.id === 'string' && !message.method) {
      const error = protocolRecord(message.error);
      settle(message.id, message.result, error ? new Error(typeof error.message === 'string' ? error.message : 'Agent rejected the request') : undefined);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      write({ id: message.id, error: { code: -32601, message: 'Helmsman does not support this interactive request' } });
      return;
    }
    options.onMessage(message);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = protocolRecord(JSON.parse(line));
        if (!message) throw new Error('Malformed agent protocol output');
        dispatch(message);
      } catch (error) { options.onFailure(error instanceof Error ? error : new Error(String(error))); }
    }
    if (buffer.length > AGENT_PROTOCOL_BUFFER_LIMIT) options.onFailure(new Error('Agent protocol output exceeded its limit'));
  });
  return {
    write, request,
    rpc: (method, params, timeout, id = randomUUID()) => request(id, { id, method, params }, timeout),
    rejectPending(error) { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); },
    pendingCount: () => pending.size,
  };
}

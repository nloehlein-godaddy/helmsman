import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_BYTES = 4096;
interface CachedPrompt { identity: string; fileId: string; size: number; anchor: string; complete: boolean; prompt: string | null; }
type PromptCache = Map<string, CachedPrompt>;

export interface PromptSurfaceBinding {
  readonly surfaceId: string;
  readonly workspaceId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function sessionId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function preview(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\0/g, '');
  if (!text.trim()) return null;
  let result = '';
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > MAX_PROMPT_BYTES) break;
    result += character;
  }
  return result || null;
}

export function promptFromTranscriptLine(value: unknown, agent: string, expectedSessionId: string): string | null {
  const row = record(value);
  if (!row) return null;
  if (agent === 'codex') {
    const payload = record(row.payload);
    if (row.type === 'event_msg' && payload?.type === 'user_message') return preview(payload.message);
    const metadata = record(row.metadata);
    const inputKinds = record(payload?.internal_chat_message_metadata_passthrough)?.content_item_kinds;
    const retainedUser = record(record(metadata?.retained_source)?.id)?.role === 'user' && Number.isSafeInteger(metadata?.user_input_order)
      && Array.isArray(inputKinds) && inputKinds.includes('user.text') && inputKinds.every(kind => typeof kind === 'string' && kind.startsWith('user.'));
    if (row.type !== 'response_item' || payload?.role !== 'user' || metadata?.client_authored !== true && !retainedUser || !Array.isArray(payload.content)) return null;
    return preview(payload.content.map(item => {
      const content = record(item);
      return content?.type === 'input_text' && typeof content.text === 'string' ? content.text : '';
    }).filter(Boolean).join('\n'));
  }
  if (agent !== 'claude' || sessionId(row.sessionId) !== expectedSessionId) return null;
  if (row.type === 'last-prompt') return preview(row.lastPrompt);
  if (row.type !== 'user' || row.isSidechain === true || row.isMeta === true || row.userType === 'internal'
    || row.promptSource !== undefined && row.promptSource !== 'typed' || row.toolUseResult !== undefined) return null;
  const message = record(row.message);
  if (message?.role !== 'user') return null;
  if (typeof message.content === 'string') return preview(message.content);
  if (!Array.isArray(message.content) || message.content.some(item => record(item)?.type === 'tool_result')) return null;
  return preview(message.content.map(item => {
    const content = record(item);
    return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
  }).filter(Boolean).join('\n'));
}

async function fileAnchor(file: FileHandle, position: number): Promise<string> {
  const bytes = Buffer.alloc(Math.min(position, 128));
  const result = await file.read(bytes, 0, bytes.length, position - bytes.length);
  if (result.bytesRead !== bytes.length) throw new Error('Transcript changed');
  return createHash('sha256').update(bytes).digest('hex');
}

async function scanPrompt(file: FileHandle, end: number, floor: number, agent: string, expectedSessionId: string, boundaryComplete: boolean, signal?: AbortSignal): Promise<string | null> {
  let position = end;
  let partial = Buffer.alloc(0);
  let discarding = true;
  while (position > floor) {
    signal?.throwIfAborted();
    const start = Math.max(floor, position - MAX_TAIL_BYTES);
    const chunk = Buffer.alloc(position - start);
    let offset = 0;
    while (offset < chunk.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(chunk, offset, chunk.length - offset, start + offset);
      if (!bytesRead) throw new Error('Transcript changed');
      offset += bytesRead;
    }
    let stop = chunk.length;
    while (stop > 0) {
      const newline = chunk.lastIndexOf(10, stop - 1);
      const lineStart = newline + 1;
      const fragment = chunk.subarray(lineStart, stop);
      if (!discarding && fragment.length + partial.length <= MAX_LINE_BYTES) {
        partial = Buffer.concat([fragment, partial]);
        if (newline >= 0 || start === 0 || start === floor && boundaryComplete) {
          try {
            const prompt = promptFromTranscriptLine(JSON.parse(partial.toString('utf8')), agent, expectedSessionId);
            if (prompt) return prompt;
          } catch {}
        }
      } else if (fragment.length + partial.length > MAX_LINE_BYTES) {
        discarding = true;
        partial = Buffer.alloc(0);
      }
      if (newline >= 0) { partial = Buffer.alloc(0); discarding = false; stop = newline; }
      else break;
    }
    position = start;
  }
  return null;
}

async function readPrompt(path: string, agent: string, expectedSessionId: string, signal?: AbortSignal, cache?: PromptCache): Promise<string | null> {
  const filename = basename(path).toLowerCase();
  if (!isAbsolute(path) || (agent === 'codex' ? !filename.endsWith(`-${expectedSessionId}.jsonl`) : filename !== `${expectedSessionId}.jsonl`)) return null;
  signal?.throwIfAborted();
  const cacheKey = `${agent}\0${expectedSessionId}\0${path}`;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) { cache?.delete(cacheKey); return null; }
    const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const fileId = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const cached = cache?.get(cacheKey);
    if (cached?.identity === identity) return cached.prompt;
    cache?.delete(cacheKey);
    const append = cached?.complete === true && cached.fileId === fileId && cached.size < info.size && await fileAnchor(file, cached.size) === cached.anchor;
    const floor = Math.max(append ? cached.size : 0, info.size - MAX_READ_BYTES);
    const fullAppend = append && floor === cached.size;
    const prompt = await scanPrompt(file, info.size, floor, agent, expectedSessionId, fullAppend, signal);
    const lastPrompt = prompt ?? (fullAppend ? cached.prompt : null);
    signal?.throwIfAborted();
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return null;
    if (cache) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      const finalByte = Buffer.alloc(1);
      if (info.size) await file.read(finalByte, 0, 1, info.size - 1);
      cache.set(cacheKey, { identity, fileId, size: info.size, anchor: await fileAnchor(file, info.size), complete: !info.size || finalByte[0] === 10, prompt: lastPrompt });
    }
    return lastPrompt;
  } catch (error) {
    cache?.delete(cacheKey);
    throw error;
  } finally {
    await file?.close();
  }
}

export async function readLastPrompts(inventory: unknown, bindings: ReadonlyMap<string, PromptSurfaceBinding>, signal?: AbortSignal, cache?: PromptCache): Promise<Map<string, string>> {
  const sessions = record(inventory)?.sessions;
  const results = new Map<string, string>();
  if (!Array.isArray(sessions) || sessions.length > 4096) return results;
  for (const [ref, binding] of bindings) {
    signal?.throwIfAborted();
    const candidates = sessions.map(record).filter(row => row && sessionId(row.surface_id) === binding.surfaceId && sessionId(row.workspace_id) === binding.workspaceId);
    const newest = candidates.reduce<Record<string, unknown> | null>((selected, row) => {
      if (!row || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) return selected;
      return !selected || Date.parse(row.updated_at) > Date.parse(String(selected.updated_at)) ? row : selected;
    }, null);
    const id = sessionId(newest?.session_id);
    const activeId = newest?.active_surface_session_id;
    if (!newest || !id || newest.stored_pid_exists !== true || typeof activeId === 'string' && activeId && sessionId(activeId) !== id
      || newest.agent !== 'codex' && newest.agent !== 'claude' || typeof newest.transcript_path !== 'string') continue;
    try {
      const prompt = await readPrompt(newest.transcript_path, newest.agent, id, signal, cache);
      if (prompt) results.set(ref, prompt);
    } catch {
      signal?.throwIfAborted();
    }
  }
  return results;
}

export function createLastPromptReader() {
  const cache: PromptCache = new Map();
  return (inventory: unknown, bindings: ReadonlyMap<string, PromptSurfaceBinding>, signal?: AbortSignal) => readLastPrompts(inventory, bindings, signal, cache);
}

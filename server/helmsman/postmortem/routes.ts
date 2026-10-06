import type { IncomingMessage, ServerResponse } from 'node:http';
import { protocolRecord } from '../agent-protocol';
import type { ApiResult } from '../router';
import type { PostmortemEvent, PostmortemRunner, StartPostmortemInput } from './runner';
import { PostmortemError } from './session-store';

const RUN_PATH = /^\/api\/runs\/([a-z\d_-]{1,128})\/postmortem$/i;
const SESSION_PATH = /^\/api\/postmortem\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\/(messages|stop))?$/i;
const EVENTS_PATH = /^\/api\/postmortem\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/events$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const EFFORT = /^[a-z]{1,16}$/;
const START_FIELDS = new Set(['provider', 'model', 'effort', 'fresh']);
const STREAM_BACKLOG_LIMIT = 2 * 1024 * 1024;

function startInput(body: unknown): StartPostmortemInput {
  if (body === null || body === undefined) return {};
  const value = protocolRecord(body);
  const invalid = () => new PostmortemError(400, 'Choose a supported provider, model and effort.');
  if (!value || Object.keys(value).some(key => !START_FIELDS.has(key))) throw invalid();
  const { provider, model, effort, fresh } = value;
  if (provider !== undefined && provider !== 'codex' && provider !== 'claude-code') throw invalid();
  if (model !== undefined && model !== null && (typeof model !== 'string' || !MODEL.test(model))) throw invalid();
  if (effort !== undefined && effort !== null && (typeof effort !== 'string' || !EFFORT.test(effort))) throw invalid();
  if (fresh !== undefined && typeof fresh !== 'boolean') throw invalid();
  return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(fresh === undefined ? {} : { fresh }) };
}

export async function handlePostmortemApi(input: { method: string; path: string; body?: unknown; caller?: string; service?: PostmortemRunner }): Promise<ApiResult | null> {
  const run = input.path.match(RUN_PATH); const session = input.path.match(SESSION_PATH);
  if (!run && !session) return null;
  if (!input.caller) return { status: 403, json: { error: 'forbidden' } };
  if (!input.service) return { status: 503, json: { error: 'Post-mortems are unavailable.' } };
  try {
    if (run && input.method === 'POST') return { status: 200, json: await input.service.start(run[1]!, startInput(input.body)) };
    if (session && !session[2] && input.method === 'GET') return { status: 200, json: await input.service.read(session[1]!) };
    if (session?.[2] === 'messages' && input.method === 'POST') {
      const body = protocolRecord(input.body);
      return { status: 200, json: await input.service.send(session[1]!, { clientId: body?.clientId, text: body?.text }) };
    }
    if (session?.[2] === 'stop' && input.method === 'POST') return { status: 200, json: await input.service.stop(session[1]!) };
    return { status: 405, json: { error: 'Method not allowed.' } };
  } catch (error) {
    if (error instanceof PostmortemError) return { status: error.status, json: { error: error.message } };
    return { status: 500, json: { error: 'Post-mortem request failed.' } };
  }
}

export async function handlePostmortemEvents(req: IncomingMessage, res: ServerResponse, pathname: string, input: { caller?: string; service?: PostmortemRunner }): Promise<boolean> {
  const match = pathname.match(EVENTS_PATH);
  if (!match || req.method !== 'GET') return false;
  const reply = (status: number, error: string) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
  if (!input.caller) { reply(403, 'forbidden'); return true; }
  if (!input.service) { reply(503, 'Post-mortems are unavailable.'); return true; }
  const service = input.service; const sessionId = match[1]!;
  const write = (event: PostmortemEvent) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > STREAM_BACKLOG_LIMIT) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const buffered: PostmortemEvent[] = [];
  let streaming = false;
  let off: (() => void) | undefined;
  try {
    off = service.subscribe(sessionId, event => { if (streaming) write(event); else buffered.push(event); });
    const snapshot = await service.read(sessionId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    write({ type: 'snapshot', snapshot });
    for (const event of buffered.splice(0)) write(event);
    streaming = true;
    const unsubscribe = () => off?.();
    res.on('close', unsubscribe);
    res.on('error', unsubscribe);
    req.on('close', unsubscribe);
  } catch (error) {
    off?.();
    reply(error instanceof PostmortemError ? error.status : 500, error instanceof PostmortemError ? error.message : 'Post-mortem request failed.');
  }
  return true;
}

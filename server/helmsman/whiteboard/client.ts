import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WhiteboardDocument {
  summary: string;
  requirements: string[];
  design: string;
  implementation: string[];
  diagram: { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label: string }[] };
}
export interface WhiteboardClient {
  check(signal?: AbortSignal): Promise<void>;
  create(input: { repositoryPath: string; baseSha: string; headSha: string; title: string }, signal?: AbortSignal): Promise<string>;
  write(sessionId: string, document: WhiteboardDocument, signal?: AbortSignal): Promise<void>;
  open(sessionId: string, signal?: AbortSignal): Promise<void>;
}
type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Whiteboard response');
  return value as JsonRecord;
}
function session(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new Error('Invalid Whiteboard session');
  return value;
}
function markdown(document: WhiteboardDocument): string {
  return [document.summary, ...(document.requirements.length ? ['## Requirements', ...document.requirements.map(item => `- ${item}`)] : []),
    '## Design', document.design, '## Implementation', ...document.implementation.map(item => `- ${item}`)].join('\n\n');
}
function component(document: WhiteboardDocument): JsonRecord {
  return { type: 'section', title: 'Helmsman review explanation', children: [
    { type: 'markdown', markdown: markdown(document) },
    ...(document.diagram.nodes.length ? [{ type: 'flow_diagram', title: 'Change flow', direction: 'down',
      nodes: document.diagram.nodes.map(node => ({ key: node.id, label: node.label })), edges: document.diagram.edges }] : []),
  ] };
}
function fingerprint(value: unknown): string {
  const root = record(value);
  const children = Array.isArray(root.children) ? root.children.map(child => {
    const item = record(child);
    if (item.type === 'markdown') return { type: item.type, markdown: item.markdown };
    if (item.type === 'flow_diagram') return { type: item.type, title: item.title,
      nodes: Array.isArray(item.nodes) ? item.nodes.map(node => { const n = record(node); return { key: n.key, label: n.label }; }) : [],
      edges: Array.isArray(item.edges) ? item.edges.map(edge => { const e = record(edge); return { from: e.from, to: e.to, label: e.label }; }) : [] };
    return item;
  }) : [];
  return createHash('sha256').update(JSON.stringify({ type: root.type, title: root.title, children })).digest('hex');
}
export function createWhiteboardClient(options: { command?: string; home?: string; environment?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): WhiteboardClient {
  const source = options.environment ?? process.env;
  const command = options.command ?? source.HELMSMAN_WHITEBOARD_CMD ?? 'whiteboard';
  const home = options.home ?? source.HELMSMAN_WHITEBOARD_HOME ?? join(homedir(), '.local', 'share', 'helmsman', 'whiteboard');
  const environment: NodeJS.ProcessEnv = { DO_NOT_TRACK: '1', DEV_REVIEW_HOME: home, DEV_REVIEW_SERVER_DIR: home };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']) if (source[key]) environment[key] = source[key];
  async function call(tool: string, input: JsonRecord, signal?: AbortSignal, desktop = false): Promise<JsonRecord> {
    signal?.throwIfAborted();
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('Whiteboard document exceeds the size limit');
    const childEnvironment = { ...environment };
    if (desktop) delete childEnvironment.DEV_REVIEW_SERVER_DIR;
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(command, [...(desktop ? [] : ['--state-dir', home]), 'api', tool, '-'], { env: childEnvironment, signal, timeout: options.timeoutMs ?? 60_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error(signal?.aborted ? 'Whiteboard request cancelled' : 'Whiteboard CLI failed; check the configured installation and local server')); return; }
        resolve(stdout);
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(encoded);
    });
    try { return record(JSON.parse(output)); } catch { throw new Error('Invalid Whiteboard response'); }
  }
  return {
    async check(signal) { await call('session_capabilities', {}, signal); },
    async create(input, signal) {
      const result = await call('session_create', { title: input.title, target: { kind: 'commits', repositoryPath: input.repositoryPath, base: input.baseSha, head: input.headSha }, open: false }, signal);
      const saved = record(result.session); const target = record(saved.target);
      if (target.kind !== 'commits' || target.base !== input.baseSha || target.head !== input.headSha || saved.repositoryPath !== input.repositoryPath) throw new Error('Whiteboard returned different source pins');
      return session(result.sessionId);
    },
    async write(sessionId, document, signal) {
      sessionId = session(sessionId);
      const content = component(document);
      const current = await call('session_get', { sessionId, format: 'json', full: true }, signal);
      if (current.sessionId !== sessionId || !Array.isArray(current.document)) throw new Error('Invalid Whiteboard document');
      const existing = current.document.filter(item => record(item).type === 'section' && record(item).title === content.title);
      if (existing.length) {
        if (existing.length !== 1 || fingerprint(existing[0]) !== fingerprint(content)) throw new Error('The Whiteboard explanation has changed; preserve the existing document');
        return;
      }
      const result = await call('session_edit', { sessionId, edit: { type: 'insert', content } }, signal);
      if (result.sessionId !== sessionId || typeof result.targetId !== 'string') throw new Error('Invalid Whiteboard edit receipt');
    },
    async open(sessionId, signal) {
      sessionId = session(sessionId);
      const capabilities = await call('session_capabilities', {}, signal, true);
      if (capabilities.desktopAvailable !== true) throw new Error('Whiteboard Desktop is not attached. Start Desktop with the configured Whiteboard state directory to view this explanation.');
      const query = { sessionId, format: 'json', full: true };
      const saved = await call('session_get', query, signal);
      const visible = await call('session_get', query, signal, true);
      const expected = record(saved.target); const actual = record(visible.target);
      if (saved.sessionId !== sessionId || visible.sessionId !== sessionId || expected.kind !== 'commits'
        || ['repositoryId', 'base', 'head'].some(key => typeof expected[key] !== 'string' || expected[key] !== actual[key])
        || actual.kind !== expected.kind) throw new Error('Whiteboard Desktop is using a different review profile');
      await call('session_open', { sessionId }, signal, true);
    },
  };
}

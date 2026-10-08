// @vitest-environment node
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createWhiteboardGenerator, parseWhiteboardDocument, validateWhiteboardSources } from './generator';
import { openWhiteboardUsageStore } from './usage-store';
import type { WhiteboardEvidence } from './service';
import type { WhiteboardDocument } from './client';

const document: WhiteboardDocument = { summary: 'Input validation changes.', requirements: [], design: 'Parser validates input.', implementation: ['parser.ts rejects missing values.'], diagram: { nodes: [{ id: 'parser', label: 'parser.ts validation' }], edges: [] } };
const evidence = { version: 1, target: { kind: 'pull-request', repo: 'owner/project', number: 7, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, title: 'Input validation', comparison: {}, diff: { files: [] }, run: null } as unknown as WhiteboardEvidence;
const upstream = { baseUrl: 'https://model.invalid/v1', authMode: 'sso-jwt' as const, credential: async () => 'private-key', assertReady: () => {} };
const result = (extra = {}) => ({ id: 'resp_fixture', model: 'gpt-6.1-sol', status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 50, total_tokens: 150 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(document) }] }], ...extra });
describe('Whiteboard model explanation', () => {
  it('requests strict bounded tool-free output through configured GoCaaS auth and records usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(result())); const onUsage = vi.fn();
    const generate = createWhiteboardGenerator({ upstream, model: 'gpt-6.1-sol', fetch: fetcher, onUsage });
    expect(await generate(evidence, new AbortController().signal)).toEqual(document);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://model.invalid/v1/responses');
    expect(request?.headers).toMatchObject({ Authorization: 'sso-jwt private-key' });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({ store: false, tools: [], max_output_tokens: 6000, text: { format: { type: 'json_schema', strict: true } } });
    expect(onUsage).toHaveBeenCalledWith(evidence, { id: 'resp_fixture', model: 'gpt-6.1-sol', inputTokens: 100, cachedInputTokens: 20, outputTokens: 50, totalTokens: 150 });
  });
  it.each([
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] },
    { output: [{ type: 'function_call', name: 'shell' }] },
  ])('rejects incomplete, refused or unexpected tool output while retaining billed usage', async extra => {
    const onUsage = vi.fn(); const generate = createWhiteboardGenerator({ upstream, model: 'gpt-6.1-sol', fetch: async () => Response.json(result(extra)), onUsage });
    await expect(generate(evidence, new AbortController().signal)).rejects.toThrow('Whiteboard explanation is unavailable');
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
  it('never exposes raw upstream failures or credentials', async () => {
    const generate = createWhiteboardGenerator({ upstream, model: 'gpt-6.1-sol', fetch: async () => { throw new Error('private-key secret'); } });
    await expect(generate(evidence, new AbortController().signal)).rejects.toThrow('Check model access or retry later');
    await expect(generate(evidence, new AbortController().signal)).rejects.not.toThrow('private-key');
  });
  it('records a returned response with unknown usage instead of dropping the cost uncertainty', async () => {
    const onUsage = vi.fn(); const generate = createWhiteboardGenerator({ upstream, model: 'gpt-6.1-sol', fetch: async () => Response.json(result({ usage: null })), onUsage });
    await generate(evidence, new AbortController().signal);
    expect(onUsage).toHaveBeenCalledWith(evidence, { id: 'resp_fixture', model: 'gpt-6.1-sol', inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null });
  });
  it('validates diagram references, document bounds and model identifiers', () => {
    expect(() => parseWhiteboardDocument({ ...document, diagram: { nodes: document.diagram.nodes, edges: [{ from: 'missing', to: 'parser', label: 'Invalid' }] } })).toThrow();
    expect(() => parseWhiteboardDocument({ ...document, summary: 'x'.repeat(3001) })).toThrow();
    expect(() => createWhiteboardGenerator({ upstream, model: 'model\nsecret' })).toThrow('Invalid Whiteboard model');
  });
  it('records PR-only usage durably and idempotently without inventing a run', () => {
    const sql = new Database(':memory:');
    try {
      const store = openWhiteboardUsageStore(sql);
      const usage = { id: 'resp_fixture', model: 'gpt-6.1-sol', inputTokens: 100, cachedInputTokens: 20, outputTokens: 50, totalTokens: 150 };
      store.record(evidence, usage); store.record(evidence, usage);
      expect(sql.prepare('SELECT COUNT(*) AS count FROM whiteboard_usage').get()).toEqual({ count: 1 });
      expect(() => store.record(evidence, { ...usage, outputTokens: 51 })).toThrow('Conflicting Whiteboard usage');
    } finally { sql.close(); }
  });
  it('accepts long opaque upstream response IDs and rejects unbounded or controlled IDs', async () => {
    const id = 'opaque_response_'.padEnd(469, 'x'); const onUsage = vi.fn();
    const generate = createWhiteboardGenerator({ upstream, model: 'gpt-6.1-sol', fetch: async () => Response.json(result({ id })), onUsage });
    await generate(evidence, new AbortController().signal);
    expect(onUsage.mock.calls[0]?.[1]?.id).toBe(id);
    const sql = new Database(':memory:');
    try {
      const store = openWhiteboardUsageStore(sql); store.record(evidence, onUsage.mock.calls[0]![1]);
      expect(sql.prepare('SELECT responseId FROM whiteboard_usage').get()).toEqual({ responseId: id });
      expect(() => store.record(evidence, { ...onUsage.mock.calls[0]![1], id: 'x'.repeat(2049) })).toThrow('Invalid Whiteboard usage');
      expect(() => store.record(evidence, { ...onUsage.mock.calls[0]![1], id: 'id\nsecret' })).toThrow('Invalid Whiteboard usage');
    } finally { sql.close(); }
  });
  it('requires exact source paths and lines from supplied diff hunks', () => {
    const input: WhiteboardEvidence = { ...evidence, diff: { ...evidence.diff, files: [{ filename: 'src/parser.ts', previousFilename: null, status: 'modified', additions: 1, deletions: 0, patchStatus: 'preview', patch: '@@ -4,2 +5,3 @@\n context\n+changed' }] } };
    const cited = { ...document, implementation: ['[parser.ts:5](review-source:head/src/parser.ts#L5-L7) validates input.'] };
    expect(() => validateWhiteboardSources(cited, input)).not.toThrow();
    expect(() => validateWhiteboardSources(document, input)).toThrow();
    expect(() => validateWhiteboardSources({ ...cited, implementation: ['[wrong](review-source:head/src/other.ts#L5)'] }, input)).toThrow();
    expect(() => validateWhiteboardSources({ ...cited, implementation: ['[wrong](review-source:head/src/parser.ts#L100)'] }, input)).toThrow();
    expect(() => validateWhiteboardSources({ ...cited, summary: 'Visit https://untrusted.invalid' }, input)).toThrow();
  });
  it('cancels stalled response-body reads and credential resolution', async () => {
    const controller = new AbortController();
    const generate = createWhiteboardGenerator({ upstream, model: 'gpt-6.1-sol', fetch: async () => new Response(new ReadableStream({ start() {} })) });
    const pending = generate(evidence, controller.signal); setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow('Whiteboard explanation is unavailable');
    const credentials = new AbortController();
    const waiting = createWhiteboardGenerator({ upstream: { ...upstream, credential: () => new Promise(() => {}) }, model: 'gpt-6.1-sol' })(evidence, credentials.signal);
    credentials.abort(); await expect(waiting).rejects.toThrow('Whiteboard explanation is unavailable');
  });
});

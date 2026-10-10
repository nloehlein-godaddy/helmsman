import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLastPromptReader, promptFromTranscriptLine, readLastPrompts } from './last-prompt';

const session = '11111111-1111-1111-1111-111111111111';
const surface = '22222222-2222-2222-2222-222222222222';
const workspace = '33333333-3333-3333-3333-333333333333';
const bindings = new Map([['surface:1', { surfaceId: surface, workspaceId: workspace }]]);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const codexPrompt = (text: string) => ({ type: 'response_item', metadata: { client_authored: false, retained_source: { id: { role: 'user' } }, user_input_order: 1 }, payload: { role: 'user', internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] }, content: [{ type: 'input_text', text }] } });

async function fixture(agent = 'codex', lines: unknown[] = [codexPrompt('Latest request')]) {
  const directory = await mkdtemp(join(tmpdir(), 'helmsman-terminal-prompt-'));
  directories.push(directory);
  const path = join(directory, agent === 'codex' ? `rollout-${session}.jsonl` : `${session}.jsonl`);
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const row = { agent, session_id: session, surface_id: surface, workspace_id: workspace,
    stored_pid_exists: true, updated_at: '2026-10-09T12:00:00Z', transcript_path: path };
  return { path, row, inventory: { sessions: [row] } };
}

describe('terminal agent prompt parsing', () => {
  it('accepts explicit Codex user input and rejects injected context, assistant output and malformed records', () => {
    expect(promptFromTranscriptLine(codexPrompt('  do\nthis  '), 'codex', session)).toBe('  do\nthis  ');
    expect(promptFromTranscriptLine(codexPrompt('hello\0world'), 'codex', session)).toBe('helloworld');
    expect(promptFromTranscriptLine({ type: 'event_msg', payload: { type: 'user_message', message: 'CLI prompt' } }, 'codex', session)).toBe('CLI prompt');
    for (const value of [null, {}, { ...codexPrompt('injected'), metadata: undefined }, { ...codexPrompt('injected'), metadata: { client_authored: false } }, { type: 'response_item', metadata: { client_authored: true }, payload: { role: 'assistant', content: [] } }]) {
      expect(promptFromTranscriptLine(value, 'codex', session)).toBeNull();
    }
  });

  it('uses bound Claude last prompts or typed text and excludes tool results, sidechains and synthetic input', () => {
    expect(promptFromTranscriptLine({ type: 'last-prompt', lastPrompt: 'Native prompt', sessionId: session }, 'claude', session)).toBe('Native prompt');
    const user = { type: 'user', sessionId: session, promptSource: 'typed', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'Typed prompt' }] } };
    expect(promptFromTranscriptLine(user, 'claude', session)).toBe('Typed prompt');
    for (const value of [{ ...user, sessionId: surface }, { ...user, isSidechain: true }, { ...user, isMeta: true }, { ...user, promptSource: 'internal' }, { ...user, toolUseResult: {} }, { ...user, message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }, { type: 'text', text: 'result' }] } }]) {
      expect(promptFromTranscriptLine(value, 'claude', session)).toBeNull();
    }
  });

  it('bounds unicode previews by UTF-8 bytes without splitting characters', () => {
    const result = promptFromTranscriptLine(codexPrompt('🦜'.repeat(3000)), 'codex', session)!;
    expect(Buffer.byteLength(result)).toBe(4096);
    expect(result).toBe('🦜'.repeat(1024));
  });
});

describe('bound terminal transcript reads', () => {
  it('reads the latest complete user prompt while ignoring trailing malformed/injected lines', async () => {
    const f = await fixture('codex', [codexPrompt('Old'), codexPrompt('Latest'), { ...codexPrompt('Context'), metadata: undefined }]);
    await writeFile(f.path, '\nnot-json\n{"type":"response_item"', { flag: 'a' });
    expect(await readLastPrompts(f.inventory, bindings)).toEqual(new Map([['surface:1', 'Latest']]));
  });

  it('joins exact workspace/surface ids and refuses stopped, stale-active and invalid-time sessions', async () => {
    const f = await fixture();
    for (const changed of [{ workspace_id: surface }, { surface_id: workspace }, { stored_pid_exists: false }, { active_surface_session_id: surface }, { updated_at: 'invalid' }, { agent: 'unknown' }]) {
      expect(await readLastPrompts({ sessions: [{ ...f.row, ...changed }] }, bindings)).toEqual(new Map());
    }
    expect(await readLastPrompts({ sessions: [f.row, { ...f.row, updated_at: '2026-10-09T13:00:00Z', stored_pid_exists: false }] }, bindings)).toEqual(new Map());
    expect(await readLastPrompts({ sessions: [{ ...f.row, active_surface_session_id: session }] }, bindings)).toEqual(new Map([['surface:1', 'Latest request']]));
  });

  it('supports native Claude transcripts and rejects unbound filenames and symlinks', async () => {
    const f = await fixture('claude', [{ type: 'last-prompt', lastPrompt: 'Claude request', sessionId: session }]);
    expect(await readLastPrompts(f.inventory, bindings)).toEqual(new Map([['surface:1', 'Claude request']]));
    const link = join(join(f.path, '..'), `rollout-${session}.jsonl`);
    await symlink(f.path, link);
    expect(await readLastPrompts({ sessions: [{ ...f.row, agent: 'codex', transcript_path: link }] }, bindings)).toEqual(new Map());
    expect(await readLastPrompts({ sessions: [{ ...f.row, transcript_path: '/tmp/unbound.jsonl' }] }, bindings)).toEqual(new Map());
  });

  it('never guesses a prompt outside the bounded tail and handles malformed inventories and cancellation', async () => {
    const f = await fixture('codex', [codexPrompt('Old'), { type: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) }]);
    expect((await readLastPrompts(f.inventory, bindings)).get('surface:1')).toBe('Old');
    await truncate(f.path, 65 * 1024 * 1024);
    await writeFile(f.path, '\n', { flag: 'a' });
    expect(await readLastPrompts(f.inventory, bindings)).toEqual(new Map());
    for (const inventory of [null, {}, { sessions: [null, {}] }]) expect(await readLastPrompts(inventory, bindings)).toEqual(new Map());
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(readLastPrompts(f.inventory, bindings, controller.signal)).rejects.toThrow('cancelled');
  });

  it('invalidates provider-local cached prompts on append, truncation, replacement and missing transcripts', async () => {
    const f = await fixture();
    const read = createLastPromptReader();
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Latest request');
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Latest request');
    await writeFile(f.path, JSON.stringify(codexPrompt('Appended')) + '\n', { flag: 'a' });
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Appended');
    await writeFile(f.path, '\n');
    expect(await read(f.inventory, bindings)).toEqual(new Map());
    await rename(f.path, `${f.path}.old`);
    await writeFile(f.path, JSON.stringify(codexPrompt('Replaced')) + '\n');
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Replaced');
    await rm(f.path);
    expect(await read(f.inventory, bindings)).toEqual(new Map());
  });

  it('reassembles a cached incomplete final user record when its remaining bytes arrive', async () => {
    const f = await fixture();
    const read = createLastPromptReader();
    const line = JSON.stringify(codexPrompt('Completed later'));
    await writeFile(f.path, line.slice(0, 30), { flag: 'a' });
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Latest request');
    await writeFile(f.path, line.slice(30) + '\n', { flag: 'a' });
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Completed later');
  });

  it('does not reuse a cached prompt when an appended gap exceeds the scan bound', async () => {
    const f = await fixture();
    const read = createLastPromptReader();
    expect((await read(f.inventory, bindings)).get('surface:1')).toBe('Latest request');
    await writeFile(f.path, JSON.stringify(codexPrompt('Unseen newer prompt')) + '\n', { flag: 'a' });
    await truncate(f.path, 65 * 1024 * 1024);
    await writeFile(f.path, '\n', { flag: 'a' });
    expect(await read(f.inventory, bindings)).toEqual(new Map());
  });
});

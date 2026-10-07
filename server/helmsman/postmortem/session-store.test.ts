/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest';
import { openPersistence, type Persistence } from '../persistence';
import { capReached, openPostmortemStore, POSTMORTEM_MESSAGE_LIMIT, PostmortemError, truncateMessage } from './session-store';

const opened: Persistence[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  let tick = 0; const store = openPostmortemStore(persistence, () => `2026-10-05T00:00:${String(tick++).padStart(2, '0')}.000Z`);
  return { persistence, store, session: store.create({ runId: 'run-1', provider: 'codex', model: null, effort: 'high', providerSessionId: null }) };
}

describe('post-mortem session store', () => {
  it('creates one open session per run and allows a new one after a terminal state', () => {
    const f = setup();
    expect(f.session).toMatchObject({ runId: 'run-1', provider: 'codex', status: 'starting', turns: 0, costUsd: null, error: null });
    expect(() => f.store.create({ runId: 'run-1', provider: 'codex', model: null, effort: null, providerSessionId: null })).toThrow(PostmortemError);
    expect(f.store.open('run-1')?.id).toBe(f.session.id);
    f.store.transition(f.session.id, 'error', { error: 'auth failed' });
    expect(f.store.open('run-1')).toBeNull();
    const next = f.store.create({ runId: 'run-1', provider: 'claude-code', model: 'opus', effort: 'high', providerSessionId: '00000000-0000-4000-8000-000000000001' });
    expect(f.store.latest('run-1')?.id).toBe(next.id);
    expect(f.store.get(f.session.id)).toMatchObject({ status: 'error', error: 'auth failed' });
  });

  it('follows the state machine and keeps capped terminal', () => {
    const f = setup(); const id = f.session.id;
    expect(() => f.store.transition(id, 'ready')).toThrow(/starting to ready/);
    f.store.transition(id, 'busy'); f.store.transition(id, 'ready', { turns: 1, costUsd: 0.5 });
    f.store.transition(id, 'busy'); f.store.transition(id, 'idle'); f.store.transition(id, 'busy');
    expect(f.store.transition(id, 'capped', { turns: 30 })).toMatchObject({ status: 'capped', turns: 30, costUsd: 0.5 });
    for (const status of ['busy', 'idle', 'error', 'ready'] as const) expect(() => f.store.transition(id, status)).toThrow(PostmortemError);
  });

  it('refuses to reopen an errored session while another session is open', () => {
    const f = setup();
    f.store.transition(f.session.id, 'error', { error: 'x' });
    f.store.create({ runId: 'run-1', provider: 'codex', model: null, effort: null, providerSessionId: null });
    expect(() => f.store.transition(f.session.id, 'busy')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('is idempotent on clientId', () => {
    const f = setup(); const clientId = '00000000-0000-4000-8000-0000000000aa';
    const first = f.store.append(f.session.id, { role: 'user', kind: 'text', text: 'Why?', clientId });
    const again = f.store.append(f.session.id, { role: 'user', kind: 'text', text: 'Why?', clientId });
    expect(first.duplicate).toBe(false); expect(again).toEqual({ message: first.message, duplicate: true });
    expect(() => f.store.append(f.session.id, { role: 'user', kind: 'text', text: 'Other', clientId })).toThrow(expect.objectContaining({ status: 409 }));
    f.store.append(f.session.id, { role: 'agent', kind: 'text', text: 'Because.' });
    f.store.append(f.session.id, { role: 'agent', kind: 'text', text: 'Also.' });
    expect(f.store.messages(f.session.id).map(message => message.text)).toEqual(['Why?', 'Because.', 'Also.']);
  });

  it('caps message text at 64 KB with a marker', () => {
    const f = setup();
    const { message } = f.store.append(f.session.id, { role: 'agent', kind: 'command', text: '😀'.repeat(20_000) });
    expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(POSTMORTEM_MESSAGE_LIMIT);
    expect(message.text.endsWith('\n[truncated]')).toBe(true);
    expect(message.text).not.toContain('�');
    expect(truncateMessage('short')).toBe('short');
  });

  it('sweeps live statuses to idle on restart', () => {
    const f = setup();
    const ready = f.store.create({ runId: 'run-2', provider: 'codex', model: null, effort: null, providerSessionId: null });
    f.store.transition(ready.id, 'busy'); f.store.transition(ready.id, 'ready');
    const capped = f.store.create({ runId: 'run-3', provider: 'codex', model: null, effort: null, providerSessionId: null });
    f.store.transition(capped.id, 'busy'); f.store.transition(capped.id, 'capped');
    expect(f.store.sweep()).toBe(2);
    expect([f.store.get(f.session.id)?.status, f.store.get(ready.id)?.status, f.store.get(capped.id)?.status]).toEqual(['idle', 'idle', 'capped']);
  });

  it('reports cap enforcement on turns and cost', () => {
    const f = setup(); const limits = { maxTurns: 30, maxCostUsd: 5 };
    expect(capReached({ ...f.session, turns: 29, costUsd: 4.99 }, limits)).toBe(false);
    expect(capReached({ ...f.session, turns: 30, costUsd: null }, limits)).toBe(true);
    expect(capReached({ ...f.session, turns: 1, costUsd: 5 }, limits)).toBe(true);
  });

  it('reopens an existing database without migration drift', () => {
    const f = setup();
    expect(() => openPostmortemStore(f.persistence)).not.toThrow();
    expect(openPostmortemStore(f.persistence).get(f.session.id)?.id).toBe(f.session.id);
  });
});

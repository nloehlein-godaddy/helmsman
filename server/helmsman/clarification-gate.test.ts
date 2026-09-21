import { describe, expect, it, vi } from 'vitest';
import { createClarificationGate } from './clarification-gate';
import { createClarificationChannel } from './clarification-protocol-store';

const channel = createClarificationChannel('/tmp/helmsman-gate', { runId: 'run-1', attempt: 2 });

describe('clarification gate attempt fencing', () => {
  it('requires exact channel evidence even when a run-wide capability remains active', () => {
    const ready = vi.fn(() => true);
    const gate = createClarificationGate({ resolve: () => ({ attempt: 2, channel, active: true }), ready });
    for (const query of ['', 'attempt=2', `attempt=1&channel=${channel.channelId}`, 'attempt=2&channel=old',
      `attempt=02&channel=${channel.channelId}`, `attempt=2&channel=${channel.channelId}&attempt=2`,
      `attempt=2&channel=${channel.channelId}&extra=1`]) expect(gate('run-1', new URLSearchParams(query))).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    expect(gate('run-1', new URLSearchParams({ attempt: '2', channel: channel.channelId }))).toBe(true);
    expect(ready).toHaveBeenCalledWith('run-1', 2, channel.channelId);
  });

  it('allows an unversioned gate only for a retained legacy execution', () => {
    const ready = vi.fn(() => true);
    const gate = createClarificationGate({ resolve: () => ({ attempt: 1, channel: null, active: true }), ready });
    expect(gate('run-1', new URLSearchParams())).toBe(true);
    expect(gate('run-1', new URLSearchParams({ attempt: '1', channel: channel.channelId }))).toBe(false);
    expect(ready).toHaveBeenCalledExactlyOnceWith('run-1', 1);
  });

  it('fails closed for missing bindings, inactive attempts and unresolved obligations', () => {
    const ready = vi.fn(() => false);
    const query = new URLSearchParams({ attempt: '2', channel: channel.channelId });
    expect(createClarificationGate({ resolve: () => { throw new Error('missing'); }, ready })('run-1', query)).toBe(false);
    expect(createClarificationGate({ resolve: () => ({ attempt: 2, channel, active: false }), ready })('run-1', query)).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    expect(createClarificationGate({ resolve: () => ({ attempt: 2, channel, active: true }), ready })('run-1', query)).toBe(false);
  });
});

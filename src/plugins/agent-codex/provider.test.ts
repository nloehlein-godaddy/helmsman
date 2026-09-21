import { describe, expect, it } from 'vitest';
import { codexAgentProvider, codexArgs, parseCodexLine } from './provider';

const input = { version: 1 as const, prompt: 'Implement T-1', model: null, effort: null, stage: 'review' as const, summaryCorrection: false, task: { ticketId: 'T-1', repo: 'org/repo', title: 'Title' } };

describe('Codex agent provider', () => {
  it('uses the provider defaults and review delegation command flag', () => {
    const args = codexArgs(input);
    expect(args).toContain('gpt-6-astra');
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('features.multi_agent=true');
    expect(args.at(-1)).toBe('Implement T-1');
    expect(codexAgentProvider.metadata).toMatchObject({ docker: 'openai-responses', costReporting: 'delta', reviewDelegation: 'review-agent-skill' });
  });

  it('accepts supported explicit effort and rejects unsupported retained tuning', () => {
    expect(codexArgs({ ...input, model: 'gpt-5.6-sol', effort: 'high' })).toContain('model_reasoning_effort="high"');
    expect(() => codexArgs({ ...input, effort: 'turbo' })).toThrow('Unsupported Codex reasoning effort');
  });

  it('maps streamed messages, usage, and errors without a run completion event', () => {
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'opened https://github.com/org/repo/pull/9' } }))).toEqual({ kind: 'result', outcome: 'unknown', text: 'opened https://github.com/org/repo/pull/9', eventId: 'm1', prNumber: 9 });
    expect(parseCodexLine(JSON.stringify({ type: 'turn.completed', turn_id: 't1', usage: { input_tokens: 3, cost_usd: 0.1 } }))).toEqual({ kind: 'usage', text: 'Codex turn completed', provider: 'codex', eventId: 't1', usage: { inputTokens: 3 }, costUsd: 0.1 });
    expect(parseCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }))).toEqual({ kind: 'result', outcome: 'failure', text: 'quota' });
    expect(parseCodexLine(JSON.stringify({ type: 'error', id: 'terminal-1', error: { message: 'fatal' } }))).toEqual({ kind: 'result', outcome: 'failure', text: 'fatal', eventId: 'terminal-1' });
  });
});

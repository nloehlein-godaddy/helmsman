import { describe, expect, it } from 'vitest';
import { claudeAgentProvider, claudeArgs, parseClaudeLine } from './provider';

const input = { version: 1 as const, prompt: 'Implement T-1', model: null, effort: null, stage: 'implement' as const, summaryCorrection: false, task: { ticketId: 'T-1', repo: 'org/repo', title: 'Title' } };

describe('Claude Code agent provider', () => {
  it('retains nullable provider defaults and maps native CLI flags', () => {
    expect(claudeArgs(input)).toEqual(['-p', 'Implement T-1', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']);
    expect(claudeAgentProvider.metadata).toMatchObject({ docker: 'anthropic-messages', costReporting: 'cumulative', reviewDelegation: 'native-subagents' });
  });

  it('marks result errors as failures and preserves cumulative cost and usage', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'failed', total_cost_usd: 0.4, usage: { input_tokens: 2, cache_read_input_tokens: 1, output_tokens: 3 } }))).toEqual({ kind: 'result', outcome: 'failure', text: 'failed', provider: 'claude-code', costUsd: 0.4, usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3 } });
    expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }))).toEqual({ kind: 'result', outcome: 'success', text: 'done' });
  });
  it('requests replay acknowledgements and retains the selected model and effort', () => {
    const interactive = claudeAgentProvider.buildInteractiveCommand?.({ ...input, model: 'sonnet', effort: 'high' });
    expect(interactive).toMatchObject({ protocol: 'claude-stream-json', initialInput: { prompt: input.prompt, model: 'sonnet', effort: 'high' } });
    expect(interactive?.command.args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--verbose',
      '--dangerously-skip-permissions', '--model', 'sonnet', '--effort', 'high']);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dockerReviewAdapter } from './docker-review';
import { codexAdapter } from './codex';
import { buildPrompt } from './prompt';
import type { AgentTask } from './adapter';
import { joinInputArguments } from '../runtime-paths';

const task: AgentTask = { ticketId: 'T-1', title: 'Review', repo: 'org/repo', jiraBaseUrl: '', review: true, prNumber: 1,
  prHeadSha: 'a'.repeat(40), dockerExecution: { runId: 'run-1', image: 'test:1', gatewayUrl: 'http://host.docker.internal:8790', capability: 'a'.repeat(64) } };
describe('Docker review adapter', () => {
  it('retains provider identity while launching a host review coordinator', () => {
    const adapter = dockerReviewAdapter(codexAdapter);
    const command = adapter.buildCommand(task);
    expect(adapter.id).toBe('codex');
    expect(command.cmd).toBe(process.execPath);
    expect(command.args[2]).toContain('docker-review-cli.ts');
    expect(command.args.slice(3).every(argument => argument.startsWith('--input=') && argument.length <= 256)).toBe(true);
    expect(JSON.parse(joinInputArguments(command.args.slice(3)))).toEqual({ task, reviewerId: 'codex' });
    expect(adapter.parseLine(JSON.stringify({ __helmsmanPrePr: 1, kind: 'usage', text: 'Usage', provider: 'codex', model: 'test', stage: 'review', round: 1, usage: { inputTokens: 10 } })))
      .toMatchObject({ kind: 'usage', stage: 'review', round: 1, usage: { inputTokens: 10 } });
    expect(() => adapter.buildCommand({ ...task, review: false })).toThrow();
  });

  it('advertises normalized delta costs for retained cumulative providers', () => {
    const metadata = { version: 1 as const, label: 'Provider', defaults: { model: null, effort: null },
      review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } },
      reviewSkills: [], reviewDelegation: 'none' as const, supportsPrePr: true, docker: null, costReporting: 'cumulative' as const };
    expect(dockerReviewAdapter({ ...codexAdapter, id: 'example.agent/provider', metadata }).metadata?.costReporting).toBe('delta');
  });

  it('directs outputs to isolated runtime paths without changing ordinary review filenames', () => {
    expect(buildPrompt(task)).toContain('`.agent-review.md` in the repo root');
    const prompt = buildPrompt({ ...task, reviewOutputPaths: { markdown: '/runtime/review.md', comments: '/runtime/review-comments.json' } });
    expect(prompt).toContain('"/runtime/review.md"');
    expect(prompt).toContain('"/runtime/review-comments.json"');
    expect(prompt).not.toContain('`.agent-review.md` in the repo root');
  });
});

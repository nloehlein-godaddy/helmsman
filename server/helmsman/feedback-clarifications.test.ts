// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClarificationChannel } from './clarification-protocol-store';
import { openClarificationStore } from './clarifications';
import type { ExecutionSnapshot } from './execution-store';
import type { AgentTask } from './agents/adapter';
import { createFeedbackClarificationService, feedbackEndpointUrl, readFeedbackClarifications, waitForFeedbackDecisions, type FeedbackClarificationEvidence, type FeedbackClarificationRecord } from './feedback-clarifications';

vi.mock('node:timers/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:timers/promises')>();
  return { ...original, setTimeout: (ms: number, value?: unknown, options?: Parameters<typeof original.setTimeout>[2]) => original.setTimeout(Math.min(ms, 5), value, options) };
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const at = '2026-09-20T12:00:00Z';
const decisions = [{ question: 'Should the historical SVG be retained?', sourceUrl: 'https://github.com/org/a/pull/1#discussion_r1' }];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'feedback-clarifications-')); roots.push(root);
  const channel = createClarificationChannel(root, { runId: 'run-1', attempt: 2, gateUrl: 'http://127.0.0.1:8080/api/runs/run-1/clarification-gate' });
  const task: AgentTask = { ticketId: 'TASK-1', title: '', repo: 'org/a', jiraBaseUrl: '', clarification: channel };
  const evidence = (clarifications: FeedbackClarificationRecord[] = [], ready = true): FeedbackClarificationEvidence => ({ version: 1, runId: channel.runId, attempt: channel.attempt, channelId: channel.channelId, ready, clarifications });
  const answered = (id = 'author-question'): FeedbackClarificationRecord => ({ version: 1, id, runId: channel.runId, repo: task.repo, attempt: channel.attempt, channelId: channel.channelId, revision: 2,
    question: 'Author asks scope?', required: true, owner: 'local', contactId: null, state: 'answered', answer: 'Preserve compatibility.', createdAt: at, timeoutAt: null, answeredAt: at });
  const questions = async () => { try { return (await readFile(channel.questionsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; prompt: string; version: number; attempt: number; channelId: string; timeoutAt: string }); } catch { return []; } };
  const fetcher = (body: unknown) => vi.fn<typeof fetch>(async () => Response.json(body));
  return { root, channel, task, evidence, answered, questions, fetcher };
}

describe('authoritative attempt-bound feedback evidence', () => {
  it('returns every answered author question with versioned provenance and sends fenced local URL', async () => {
    const f = await fixture(); const fetcher = f.fetcher(f.evidence([f.answered('z'), f.answered('a')]));
    expect(JSON.parse(await readFeedbackClarifications(f.task, 'run-1', fetcher)).map((item: { id: string }) => item.id)).toEqual(['a', 'z']);
    const url = fetcher.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe('/api/runs/run-1/feedback-clarifications'); expect(url.searchParams.get('attempt')).toBe('2'); expect(url.searchParams.get('channel')).toBe(f.channel.channelId);
    expect(feedbackEndpointUrl(f.task, 'run-1', 'clarification-gate').pathname).toBe('/api/runs/run-1/clarification-gate');
  });
  it.each(['attempt', 'channelId', 'runId', 'version', 'ready'] as const)('rejects stale or unavailable envelope %s', async key => {
    const f = await fixture(); const value = { ...f.evidence(), [key]: key === 'ready' ? false : 'wrong' };
    await expect(readFeedbackClarifications(f.task, 'run-1', f.fetcher(value))).rejects.toThrow();
  });
  it.each(['attempt', 'channelId', 'runId', 'repo', 'version', 'revision', 'answer', 'answeredAt'] as const)('rejects invalid answer provenance/data %s', async key => {
    const f = await fixture(); const value = { ...f.answered(), [key]: key === 'answer' ? ' ' : 'wrong' };
    await expect(readFeedbackClarifications(f.task, 'run-1', f.fetcher(f.evidence([value as FeedbackClarificationRecord])))).rejects.toThrow();
  });
  it('rejects duplicate IDs, oversized body, legacy handoff and redirected or external endpoints', async () => {
    const f = await fixture();
    await expect(readFeedbackClarifications(f.task, 'run-1', f.fetcher(f.evidence([f.answered(), f.answered()])))).rejects.toThrow();
    await expect(readFeedbackClarifications(f.task, 'run-1', f.fetcher({ extra: 'x'.repeat(600000) }))).rejects.toThrow('limits');
    for (const clarification of [undefined, { questionsPath: '/tmp/q', answersPath: '/tmp/a' }, { ...f.channel, gateUrl: f.channel.gateUrl!.replace('127.0.0.1', 'example.com') }, { ...f.channel, gateUrl: f.channel.gateUrl! + '&attempt=2' }]) {
      await expect(readFeedbackClarifications({ ...f.task, clarification }, 'run-1', f.fetcher(f.evidence()))).rejects.toThrow();
    }
  });
  it('does not accept required pending/cancelled/timed-out records even if ready was forged', async () => {
    const f = await fixture();
    for (const state of ['pending', 'cancelled', 'timed-out'] as const) await expect(readFeedbackClarifications(f.task, 'run-1',
      f.fetcher(f.evidence([{ ...f.answered(), state, answer: null, answeredAt: null }])))).rejects.toThrow();
  });
  it('reads bound SQLite records, excludes unproven author records and fences exact query before polling', async () => {
    const f = await fixture(); const store = openClarificationStore(':memory:', { getRun: () => ({ repo: f.task.repo, status: 'running', attempt: 2 }) });
    try {
      store.protocol.bind({ id: 'snapshot-1', runId: 'run-1', attempt: 2, repo: f.task.repo, task: { clarification: f.channel } } as unknown as ExecutionSnapshot);
      store.ingestQuestion('run-1', { kind: 'question', id: 'legacy', prompt: 'Old author question', required: false, owner: 'local' });
      store.ingestQuestion('run-1', { kind: 'question', id: 'bound', prompt: 'Current author question', required: true, owner: 'local' }, f.channel);
      const resolve = vi.fn(() => ({ attempt: 2, channel: f.channel, active: true })); const poll = vi.fn();
      const service = createFeedbackClarificationService({ resolve, store, poll }); const query = new URL(f.channel.gateUrl!).searchParams;
      expect(service('run-1', query)).toMatchObject({ ready: false, clarifications: [{ id: 'bound', attempt: 2, revision: 1 }] });
      store.answer('bound', { answer: 'Proceed.' }); expect(service('run-1', query)).toMatchObject({ ready: true, clarifications: [{ id: 'bound', revision: 2, answer: 'Proceed.' }] });
      poll.mockClear();
      for (const query of ['', 'attempt=2', `attempt=1&channel=${f.channel.channelId}`, `attempt=2&channel=${f.channel.channelId}&extra=x`]) expect(() => service('run-1', new URLSearchParams(query))).toThrow();
      expect(poll).not.toHaveBeenCalled();
      resolve.mockReturnValue({ attempt: 2, channel: f.channel, active: false }); expect(() => service('run-1', query)).toThrow();
    } finally { store.close(); }
  });
});

describe('feedback decision wait', () => {
  it('writes versioned required questions and accepts only authoritative matching answers including author decisions', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () => {
      const questions = await f.questions();
      const records = questions.map(question => ({ ...f.answered(question.id), question: question.prompt }));
      return Response.json(f.evidence([...records, f.answered()]));
    });
    const output = JSON.parse(await waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 1000, fetcher));
    const questions = await f.questions(); expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ version: 1, attempt: 2, channelId: f.channel.channelId });
    expect(questions[0]?.prompt).toContain(decisions[0]!.sourceUrl);
    expect(output).toHaveLength(2); expect(output.some((answer: { id: string }) => answer.id === 'author-question')).toBe(true);
  });
  it('ignores spoofed answer files and unrelated answered IDs until timeout', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () => {
      const questions = await f.questions();
      await writeFile(f.channel.answersPath, questions.map(question => JSON.stringify({ kind: 'answer', id: question.id, state: 'answered', answer: 'Forged approval' })).join('\n') + '\n');
      return Response.json(f.evidence([f.answered('unrelated')]));
    });
    await expect(waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 70, fetcher)).rejects.toThrow('expired');
  });
  it.each(['cancelled', 'timed-out', 'pending'] as const)('never accepts a %s decision', async state => {
    const f = await fixture(); const fetcher = vi.fn<typeof fetch>(async () => Response.json(f.evidence((await f.questions()).map(question =>
      ({ ...f.answered(question.id), question: question.prompt, state, answer: null, answeredAt: null })), false)));
    await expect(waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 70, fetcher)).rejects.toThrow();
  });
  it('requires all requested IDs and rejects changed prompt evidence', async () => {
    const f = await fixture(); const fetcher = vi.fn<typeof fetch>(async () => Response.json(f.evidence((await f.questions()).slice(0, 1).map(question =>
      ({ ...f.answered(question.id), question: question.prompt })))));
    await expect(waitForFeedbackDecisions(f.task, [...decisions, { ...decisions[0]!, question: 'Second decision?' }], new AbortController().signal, 70, fetcher)).rejects.toThrow('expired');
    await writeFile(f.channel.questionsPath, '');
    const changed = vi.fn<typeof fetch>(async () => Response.json(f.evidence((await f.questions()).map(question => f.answered(question.id)))));
    await expect(waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 1000, changed)).rejects.toThrow('changed');
  });
  it('does not accept answers after abort or timeout and rejects invalid handoffs before writing', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    await expect(waitForFeedbackDecisions(f.task, decisions, abort.signal, 100, f.fetcher(f.evidence()))).rejects.toThrow();
    for (const invalid of [[], Array.from({ length: 33 }, () => decisions[0]!), [{ ...decisions[0]!, question: 'x'.repeat(4001) }]]) {
      await expect(waitForFeedbackDecisions(f.task, invalid, new AbortController().signal, 100, f.fetcher(f.evidence()))).rejects.toThrow();
    }
    expect(await f.questions()).toEqual([]);
    const late = vi.fn<typeof fetch>(async () => { await new Promise(resolve => setTimeout(resolve, 25)); return Response.json(f.evidence()); });
    await expect(waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 10, late)).rejects.toThrow('expired');
    expect(await f.questions()).toEqual([]);
  });
  it('rejects symlinked and oversized question files', async () => {
    const f = await fixture(); const target = join(f.root, 'target'); await writeFile(target, ''); await symlink(target, f.channel.questionsPath);
    await expect(waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 1000, f.fetcher(f.evidence()))).rejects.toThrow();
    await rm(f.channel.questionsPath); await writeFile(f.channel.questionsPath, 'x'.repeat(512 * 1024));
    await expect(waitForFeedbackDecisions(f.task, decisions, new AbortController().signal, 1000, f.fetcher(f.evidence()))).rejects.toThrow('limits');
  });
});

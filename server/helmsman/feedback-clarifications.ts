import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTask } from './agents/adapter';
import type { FeedbackDecision } from './feedback-update-workflow';
import { CLARIFICATION_OWNERS, CLARIFICATION_STATES, type Clarification } from '../../src/data/clarifications';
import { MAX_CLARIFICATIONS_PER_RUN, type ClarificationStore } from './clarifications';
import { parseClarificationChannel, type ClarificationChannel } from './clarification-protocol-store';

export interface FeedbackClarificationRecord extends Clarification { version: 1; attempt: number; channelId: string; revision: number; }
export interface FeedbackClarificationEvidence {
  version: 1; runId: string; attempt: number; channelId: string; ready: boolean; clarifications: FeedbackClarificationRecord[];
}
const maxBytes = 512 * 1024;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d_-]{1,128}$/i.test(value);
const validText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 4000;
const validTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createFeedbackClarificationService(input: {
  resolve(runId: string): { attempt: number; channel: ClarificationChannel | null; active: boolean };
  store: ClarificationStore;
  poll(runId: string, attempt: number, channelId: string): void;
}): (runId: string, query: URLSearchParams) => FeedbackClarificationEvidence {
  return (runId, query) => {
    function binding() {
      const retained = input.resolve(runId); const channel = retained.channel;
      if (!validId(runId) || !retained.active || !channel || channel.version !== 1 || channel.runId !== runId || channel.attempt !== retained.attempt
        || query.size !== 2 || query.getAll('attempt').length !== 1 || query.getAll('channel').length !== 1
        || query.get('attempt') !== String(retained.attempt) || query.get('channel') !== channel.channelId) throw new Error('Feedback clarification attempt is unavailable');
      return channel;
    }
    const channel = binding();
    input.poll(runId, channel.attempt, channel.channelId);
    if (JSON.stringify(binding()) !== JSON.stringify(channel)) throw new Error('Feedback clarification attempt changed');
    const questions = input.store.listForChannel(channel);
    if (questions.length > MAX_CLARIFICATIONS_PER_RUN) throw new Error('Feedback clarification limit exceeded');
    const clarifications = questions.map(question => {
      const provenance = input.store.protocol.provenance(question.id);
      if (provenance?.kind !== 'attempt-channel' || provenance.attempt !== channel.attempt || provenance.channelId !== channel.channelId) throw new Error('Feedback clarification provenance is unavailable');
      return { ...question, version: 1 as const, attempt: channel.attempt, channelId: channel.channelId, revision: provenance.revision };
    });
    return { version: 1, runId, attempt: channel.attempt, channelId: channel.channelId,
      ready: !input.store.hasRequiredUnanswered(runId), clarifications };
  };
}

function endpoint(task: AgentTask, runId: string): { url: URL; channel: ClarificationChannel } {
  const channel = parseClarificationChannel(task.clarification);
  if (!channel || channel.runId !== runId || typeof channel.gateUrl !== 'string' || channel.gateUrl.length > 2048) throw new Error('Versioned feedback clarification handoff is unavailable');
  const url = new URL(channel.gateUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== `/api/runs/${runId}/clarification-gate` || url.username || url.password || url.hash
    || url.searchParams.size !== 2 || url.searchParams.getAll('attempt').length !== 1 || url.searchParams.getAll('channel').length !== 1
    || url.searchParams.get('attempt') !== String(channel.attempt) || url.searchParams.get('channel') !== channel.channelId) throw new Error('Feedback clarification endpoint must match this local attempt');
  url.pathname = `/api/runs/${runId}/feedback-clarifications`;
  return { url, channel };
}

export function feedbackEndpointUrl(task: AgentTask, runId: string, suffix: 'feedback-clarifications' | 'clarification-gate' = 'feedback-clarifications'): URL {
  const { url } = endpoint(task, runId);
  url.pathname = `/api/runs/${runId}/${suffix}`;
  return url;
}

function parseEvidence(value: unknown, task: AgentTask, channel: ClarificationChannel): FeedbackClarificationEvidence {
  if (!record(value) || value.version !== 1 || value.runId !== channel.runId || value.attempt !== channel.attempt || value.channelId !== channel.channelId
    || typeof value.ready !== 'boolean' || !Array.isArray(value.clarifications) || value.clarifications.length > MAX_CLARIFICATIONS_PER_RUN) throw new Error('Invalid feedback clarification evidence');
  const ids = new Set<string>();
  const clarifications = value.clarifications.map((item: unknown): FeedbackClarificationRecord => {
    if (!record(item) || item.version !== 1 || item.attempt !== channel.attempt || item.channelId !== channel.channelId
      || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || !validId(item.id) || ids.has(item.id) || item.runId !== channel.runId
      || typeof item.repo !== 'string' || item.repo.toLowerCase() !== task.repo.toLowerCase() || !validText(item.question)
      || typeof item.required !== 'boolean' || !CLARIFICATION_OWNERS.some(owner => owner === item.owner)
      || !CLARIFICATION_STATES.some(state => state === item.state) || !validTime(item.createdAt)
      || !(item.timeoutAt === null || validTime(item.timeoutAt)) || !(item.contactId === null || validId(item.contactId))
      || (item.state === 'answered' ? !validText(item.answer) || !validTime(item.answeredAt) : item.answer !== null || item.answeredAt !== null)) throw new Error('Invalid feedback clarification record or attempt scope');
    ids.add(item.id);
    return { version: 1, id: item.id, runId: channel.runId, repo: item.repo, attempt: channel.attempt, channelId: channel.channelId,
      revision: item.revision as number, question: item.question, required: item.required, owner: item.owner as Clarification['owner'],
      contactId: item.contactId as string | null, state: item.state as Clarification['state'], answer: item.answer as string | null,
      createdAt: item.createdAt, timeoutAt: item.timeoutAt as string | null, answeredAt: item.answeredAt as string | null };
  });
  if (value.ready && clarifications.some(item => item.required && item.state !== 'answered')) throw new Error('Required clarification has not been answered');
  return { version: 1, runId: channel.runId, attempt: channel.attempt, channelId: channel.channelId, ready: value.ready, clarifications };
}

async function readEvidence(task: AgentTask, runId: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<FeedbackClarificationEvidence> {
  const { url, channel } = endpoint(task, runId);
  const requestSignal = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]);
  requestSignal.throwIfAborted();
  const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: requestSignal,
    ...(task.clarification?.gateToken ? { headers: { Authorization: `Bearer ${task.clarification.gateToken}` } } : {}) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Feedback clarification evidence is unavailable'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = '';
  try {
    while (true) {
      requestSignal.throwIfAborted(); const next = await reader.read(); requestSignal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('Feedback clarification evidence exceeds limits');
      text += decoder.decode(next.value, { stream: true });
    }
    return parseEvidence(JSON.parse(text + decoder.decode()), task, channel);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function answeredEvidence(evidence: FeedbackClarificationEvidence): string {
  const answers = evidence.clarifications.filter(item => item.state === 'answered').map(item => ({ id: item.id, question: item.question,
    answer: item.answer, owner: item.owner, answeredAt: item.answeredAt, required: item.required,
    version: item.version, attempt: item.attempt, channelId: item.channelId, revision: item.revision })).sort((a, b) => a.id.localeCompare(b.id));
  return answers.length ? JSON.stringify(answers, null, 2) : '';
}
export async function readFeedbackClarifications(task: AgentTask, runId: string, fetcher: typeof fetch = fetch): Promise<string> {
  const evidence = await readEvidence(task, runId, fetcher);
  if (!evidence.ready) throw new Error('Required feedback clarification has not been answered');
  return answeredEvidence(evidence);
}

export async function waitForFeedbackDecisions(task: AgentTask, decisions: FeedbackDecision[], signal: AbortSignal,
  timeoutMs: number, fetcher: typeof fetch = fetch): Promise<string> {
  signal.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 24 * 60 * 60_000) throw new Error('Invalid feedback decision timeout');
  if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > MAX_CLARIFICATIONS_PER_RUN) throw new Error('Required feedback clarification handoff is unavailable');
  const runId = task.clarification?.runId;
  if (!validId(runId)) throw new Error('Versioned feedback clarification handoff is unavailable');
  const { channel } = endpoint(task, runId);
  const deadline = Date.now() + timeoutMs;
  const check = () => { signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error('Required feedback decision expired without an answer'); };
  const questions = decisions.map(decision => {
    if (!decision || !validText(decision.question) || typeof decision.sourceUrl !== 'string' || !decision.sourceUrl.trim() || decision.sourceUrl.length > 2000) throw new Error('Invalid feedback decision');
    const prompt = `${decision.question}\n\nFinding: ${decision.sourceUrl}`;
    if (!validText(prompt)) throw new Error('Required feedback clarification records exceed protocol limits');
    return { kind: 'question', version: 1, runId, attempt: channel.attempt, channelId: channel.channelId, id: randomUUID(), required: true,
      prompt, owner: 'local', timeoutAt: new Date(deadline).toISOString() };
  });
  const initial = await readEvidence(task, runId, fetcher, signal); check();
  if (initial.clarifications.length + questions.length > MAX_CLARIFICATIONS_PER_RUN) throw new Error('Feedback clarification limit exceeded');
  const payload = questions.map(question => JSON.stringify(question)).join('\n') + '\n';
  const file = await open(channel.questionsPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await file.stat(); check();
    if (!info.isFile() || info.size + Buffer.byteLength(payload) > maxBytes) throw new Error('Required feedback clarification records exceed protocol limits');
    await file.writeFile(payload);
  } finally { await file.close(); }
  while (true) {
    check(); const evidence = await readEvidence(task, runId, fetcher, signal); check();
    const matched = questions.map(question => {
      const answer = evidence.clarifications.find(item => item.id === question.id);
      if (answer && (answer.question !== question.prompt || !answer.required || answer.owner !== 'local'
        || answer.state === 'cancelled' || answer.state === 'timed-out')) throw new Error('Required feedback decision was changed, cancelled, or expired');
      return answer?.state === 'answered';
    });
    if (evidence.ready && matched.every(Boolean)) return answeredEvidence(evidence);
    await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

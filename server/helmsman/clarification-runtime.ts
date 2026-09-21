import { lstatSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseClarificationQuestionLine, type ClarificationStore } from './clarifications';
import type { ClarificationChannel } from './clarification-protocol-store';

export function clarificationPaths(runsDir: string, runId: string) {
  if (!/^[a-z\d_-]{1,128}$/i.test(runId)) throw new Error('Invalid clarification run ID');
  return { questionsPath: join(runsDir, `${runId}.clarifications.jsonl`), answersPath: join(runsDir, `${runId}.clarification-answers.jsonl`) };
}

export function createClarificationRuntime(store: ClarificationStore, runsDir: string, options?: {
  resolve(runId: string, expectedAttempt?: number): { attempt: number; channel: ClarificationChannel | null };
}) {
  const lastOutput = new Map<string, string>();
  function binding(runId: string, expectedAttempt?: number, expectedChannelId?: string) {
    const retained = options?.resolve(runId, expectedAttempt);
    if (expectedAttempt !== undefined && retained?.attempt !== expectedAttempt
      || expectedChannelId !== undefined && retained?.channel?.channelId !== expectedChannelId
      || retained?.channel && (retained.channel.runId !== runId || retained.channel.attempt !== retained.attempt
        || dirname(retained.channel.questionsPath) !== resolve(runsDir) || dirname(retained.channel.answersPath) !== resolve(runsDir))) throw new Error('Clarification attempt binding changed');
    return retained?.channel ?? null;
  }
  function ingest(runId: string, questionsPath: string, channel?: ClarificationChannel, terminal = false): void {
    let data = '';
    try {
      const stat = lstatSync(questionsPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Invalid clarification question file');
      data = readFileSync(questionsPath, 'utf8');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const lines = data.slice(0, data.lastIndexOf('\n') + 1).split('\n').filter(line => line.trim());
    for (const line of lines) store.ingestQuestion(runId, parseClarificationQuestionLine(line), channel);
    if (terminal && data.slice(data.lastIndexOf('\n') + 1).trim()) throw new Error('Terminal clarification question file has an incomplete record');
  }
  return {
    poll(runId: string, expectedAttempt?: number, expectedChannelId?: string, terminal = false) {
      const channel = binding(runId, expectedAttempt, expectedChannelId);
      const paths = channel ?? clarificationPaths(runsDir, runId);
      if (channel) ingest(runId, clarificationPaths(runsDir, runId).questionsPath, undefined, terminal);
      ingest(runId, paths.questionsPath, channel ?? undefined, terminal);
      store.timeoutDue();
      const questions = channel ? store.listForChannel(channel)
        : store.listForRun(runId).filter(question => store.protocol.provenance(question.id)?.kind === 'legacy-unproven');
      const answers = questions.filter(question => question.state !== 'pending').map(question => ({
        kind: 'answer', id: question.id, state: question.state, answer: question.answer, answeredAt: question.answeredAt,
      })).map(record => JSON.stringify(record)).join('\n');
      const outputKey = channel?.channelId ?? runId;
      if (answers && lastOutput.get(outputKey) !== answers) {
        const temporary = `${paths.answersPath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${answers}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, paths.answersPath);
        lastOutput.set(outputKey, answers);
      }
      if (store.hasRequiredTimedOut(runId)) throw new Error('Required clarification timed out without an answer');
    },
    hasUnanswered(runId: string, expectedAttempt?: number, expectedChannelId?: string) {
      binding(runId, expectedAttempt, expectedChannelId); return store.hasRequiredUnanswered(runId);
    },
    complete(runId: string, expectedAttempt?: number) {
      const channel = binding(runId, expectedAttempt);
      if (channel) store.cancelForChannel(channel); else store.cancelForRun(runId);
      lastOutput.delete(channel?.channelId ?? runId);
    },
  };
}

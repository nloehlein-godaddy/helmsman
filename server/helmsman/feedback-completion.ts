import type { AgentTask } from './agents/adapter';
import type { Db } from './db';
import { parseFeedbackOutcome } from '../../src/logic/feedbackOutcome';

export function hasVerifiedFeedbackCompletion(db: Pick<Db, 'listEvents'>, runId: string, task: AgentTask): boolean {
  const channel = task.clarification;
  if (!channel || channel.version !== 1 || channel.runId !== runId) return false;
  const latest = db.listEvents(runId).filter(event => event.kind === 'feedback-outcome').at(-1);
  if (!latest || parseFeedbackOutcome(latest.text)?.state !== 'completed') return false;
  try {
    const value: unknown = JSON.parse(latest.text);
    return value !== null && typeof value === 'object' && 'attempt' in value && value.attempt === channel.attempt
      && 'channelId' in value && value.channelId === channel.channelId;
  } catch { return false; }
}

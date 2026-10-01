import type { AgentTask } from './agents/adapter';
import type { Db } from './db';

export function hasVerifiedFeedbackCompletion(db: Pick<Db, 'getRun' | 'latestFeedbackOutcome'>, runId: string, task: AgentTask): boolean {
  const channel = task.clarification;
  if (!channel || channel.version !== 1 || channel.runId !== runId) return false;
  const row = db.getRun(runId);
  if (!row?.taskJson || row.attempt !== channel.attempt) return false;
  try {
    const saved = JSON.parse(row.taskJson) as Partial<AgentTask> | null;
    return saved?.clarification?.version === 1 && saved.clarification.runId === runId
      && saved.clarification.attempt === channel.attempt && saved.clarification.channelId === channel.channelId
      && db.latestFeedbackOutcome(runId)?.state === 'completed';
  } catch { return false; }
}

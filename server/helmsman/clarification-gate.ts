import type { ClarificationChannel } from './clarification-protocol-store';

export function createClarificationGate(input: {
  resolve(runId: string): { attempt: number; channel: ClarificationChannel | null; active: boolean };
  ready(runId: string, attempt: number, channelId?: string): boolean;
}) {
  return (runId: string, query: URLSearchParams): boolean => {
    try {
      const retained = input.resolve(runId);
      if (!retained.active) return false;
      if (!retained.channel) return query.size === 0 && input.ready(runId, retained.attempt);
      if (query.size !== 2 || query.getAll('attempt').length !== 1 || query.getAll('channel').length !== 1
        || query.get('attempt') !== String(retained.attempt) || query.get('channel') !== retained.channel.channelId) return false;
      return input.ready(runId, retained.attempt, retained.channel.channelId);
    } catch { return false; }
  };
}

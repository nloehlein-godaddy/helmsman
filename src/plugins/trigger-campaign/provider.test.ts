import { describe, expect, it } from 'vitest';
import type { CampaignTriggerInputV1 } from '../trigger';
import { campaignTriggerProvider } from './provider';

const input: CampaignTriggerInputV1 = {
  version: 1,
  truncated: false,
  candidates: [
    { candidateId: 'older', repo: 'org/repo', campaignId: 'campaign', phaseId: 'phase', taskId: 'task-1', attempt: 1, workflowRef: 'coding@1', title: 'Older', mode: 'ticket', createdAt: '2026-09-21T00:00:00Z' },
    { candidateId: 'newer', repo: 'org/repo', campaignId: 'campaign', phaseId: 'phase', taskId: 'task-2', attempt: 1, workflowRef: 'coding@1', title: 'Newer', mode: 'ticket', createdAt: '2026-09-21T00:01:00Z' },
  ],
};

describe('campaign trigger', () => {
  it('preserves FIFO choice over the eligible core projection', () => {
    const provider = campaignTriggerProvider({ enabled: true, intervalMs: 5_000 });
    expect(provider.select(input)).toEqual({ candidateId: 'older' });
    expect(provider.metadata).toEqual({ version: 1, label: 'Campaign dispatch', kind: 'campaign', intervalMs: 5_000 });
  });

  it('defers without mutating candidates when disabled or empty', () => {
    expect(campaignTriggerProvider({ enabled: false, intervalMs: 5_000 }).select(input)).toBeNull();
    expect(campaignTriggerProvider({ enabled: true, intervalMs: 5_000 }).select({ ...input, candidates: [] })).toBeNull();
    expect(input.candidates.map(candidate => candidate.candidateId)).toEqual(['older', 'newer']);
  });
});

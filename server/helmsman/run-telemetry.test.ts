import { describe, expect, it } from 'vitest';
import { createOutcomeTelemetrySink, openOutcomeStore } from './outcomes';
import { openRunTelemetry } from './run-telemetry';
import { openUsageStore } from './usage-store';
import type { RunRow } from './db';
import type { AgentTask } from './agents/adapter';

const task = { repo: 'o/r', ticketId: 'task', title: 'task', jiraBaseUrl: '' };
const row: RunRow = { id: 'run-1', repo: 'o/r', ticketId: 'task', adapter: 'codex', attempt: 1,
  status: 'succeeded', prNumber: null, startedAt: '2026-09-18T00:00:00Z', endedAt: '2026-09-18T00:01:00Z', costUsd: null, worktreePath: null };

const cumulativeTask: AgentTask = { ...task, agentSelection: { version: 1, writer: { version: 1,
  binding: { providerId: 'example.agent/claude', pluginId: 'example.agent', artifactHash: 'a'.repeat(64), contractVersion: 1 }, origin: 'external', settings: {},
  metadata: { version: 1, label: 'Claude', defaults: { model: null, effort: null }, review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } }, reviewSkills: [], reviewDelegation: 'native-subagents', supportsPrePr: true, docker: 'anthropic-messages', costReporting: 'cumulative' } }, reviewers: [] } };

describe('run telemetry integration', () => {
  it('replays a logged usage event without doubling cost, including a crash before updating the run row', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes, createOutcomeTelemetrySink(outcomes));
    const event = { kind: 'usage' as const, text: 'usage', costUsd: 2, usage: { inputTokens: 12 } };
    expect(telemetry.record(row, task, event, 10)).toBe(2);
    expect(telemetry.record(row, task, event, 10)).toBe(2);
    expect(telemetry.record({ ...row, attempt: 2 }, task, event, 10)).toBe(4);
    expect(outcomes.listUsage([row.id])).toHaveLength(2);
    telemetry.close(); outcomes.close();
  });
  it('keeps unpriced usage unknown and execution success unassessed', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes, createOutcomeTelemetrySink(outcomes));
    expect(telemetry.record(row, task, { kind: 'usage', text: 'usage', usage: { outputTokens: 5 }, stage: 'fix', round: 3 }, 0)).toBeNull();
    telemetry.complete(row);
    expect(outcomes.getAssessment(row.id)).toMatchObject({ state: 'not-assessed', outcome: 'unknown', correctionRounds: 2 });
    telemetry.close(); outcomes.close();
  });
  it('normalizes cumulative retained-provider costs across replay, decreases, restart, and attempts', () => {
    const usage = openUsageStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', usage);
    const event = (costUsd: number, stage?: string) => ({ kind: 'usage' as const, text: 'usage', provider: 'claude-code', costUsd, ...(stage ? { stage } : {}) });
    const native = { ...row, adapter: 'example.agent/claude' };
    expect(telemetry.record(native, cumulativeTask, event(2), 10)).toBe(2);
    expect(telemetry.record(native, cumulativeTask, event(1), 20)).toBe(2);
    expect(telemetry.record(native, cumulativeTask, event(3), 30)).toBe(3);
    expect(telemetry.record(native, cumulativeTask, event(3), 30)).toBe(3);
    expect(() => telemetry.record(native, cumulativeTask, { ...event(3.5), model: 'changed' }, 30)).toThrow('Usage event already exists with different values');
    telemetry.close();

    const recovered = openRunTelemetry(':memory:', usage);
    expect(recovered.record(native, cumulativeTask, event(2.5), 40)).toBe(3);
    expect(recovered.record(native, cumulativeTask, event(4), 50)).toBe(4);
    expect(recovered.record({ ...native, attempt: 2 }, cumulativeTask, event(1), 10)).toBe(5);
    expect(recovered.record({ ...row, adapter: 'pre-pr:example.agent/claude' }, cumulativeTask, event(2, 'review'), 60)).toBe(7);
    recovered.close(); usage.close();
  });
  it('preserves human evidence on reattachment/finalization', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes, createOutcomeTelemetrySink(outcomes));
    outcomes.saveAssessment({ runId: row.id, state: 'complete', outcome: 'achieved', summary: 'verified', evidence: ['test report'] });
    telemetry.complete(row);
    expect(outcomes.getAssessment(row.id)?.outcome).toBe('achieved');
    telemetry.close(); outcomes.close();
  });
  it('refreshes automatic failure and correction evidence after a successful resume', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes, createOutcomeTelemetrySink(outcomes));
    telemetry.record(row, task, { kind: 'error', text: 'review failed', stage: 'review', round: 1 }, 10);
    telemetry.complete({ ...row, status: 'failed' });
    expect(outcomes.getAssessment(row.id)).toMatchObject({ source: 'telemetry', failureStage: 'review', correctionRounds: 0 });
    telemetry.record({ ...row, attempt: 2 }, task, { kind: 'phase', text: 'corrected', stage: 'fix', round: 2 }, 20);
    telemetry.complete({ ...row, attempt: 2 });
    expect(outcomes.getAssessment(row.id)).toMatchObject({ state: 'not-assessed', outcome: 'unknown', failureStage: null, correctionRounds: 1 });
    telemetry.close(); outcomes.close();
  });
  it('preserves a human not-assessed decision during later completion', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes, createOutcomeTelemetrySink(outcomes));
    outcomes.saveAssessment({ runId: row.id, state: 'not-assessed', outcome: 'unknown', summary: 'Awaiting independent check', evidence: [] });
    telemetry.complete(row);
    expect(outcomes.getAssessment(row.id)).toMatchObject({ source: 'manual', summary: 'Awaiting independent check' });
    telemetry.close(); outcomes.close();
  });

});

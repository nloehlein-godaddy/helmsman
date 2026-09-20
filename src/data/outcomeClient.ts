import { ASSESSMENT_STATES, TASK_OUTCOMES, type OutcomeAssessment, type OutcomeSummary } from './outcomes';

export const OUTCOME_WINDOWS = [7, 30, 90, 365] as const;
export type OutcomeWindow = typeof OUTCOME_WINDOWS[number];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const EXECUTION_STATES = ['running', 'succeeded', 'failed', 'stopped'] as const;
const nonNegativeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonNegativeInteger = (value: unknown): value is number => nonNegativeNumber(value) && Number.isSafeInteger(value);
const nullableNumber = (value: unknown): boolean => value === null || nonNegativeNumber(value);
const nullableInteger = (value: unknown): boolean => value === null || nonNegativeInteger(value);

function validCounts(value: unknown, keys: readonly string[]): boolean {
  const counts = record(value);
  return counts !== null && keys.every(key => nonNegativeInteger(counts[key]));
}

function validEstimate(value: unknown): boolean {
  if (value === undefined) return true;
  const estimate = record(value);
  if (!estimate) return false;
  const amount = estimate.estimatedUnreportedCostUsd;
  const estimated = estimate.estimatedUsageEvents;
  const unreported = estimate.unreportedUsageEvents;
  return nullableNumber(amount) && nonNegativeInteger(estimated) && nonNegativeInteger(unreported)
    && unreported >= estimated && (estimated === 0 ? amount === null : amount !== null);
}

function validDay(value: unknown): boolean {
  const day = record(value);
  return day !== null && typeof day.date === 'string'
    && validCounts(day, ['runs', 'runsWithKnownCost', ...EXECUTION_STATES])
    && nullableNumber(day.knownCostUsd) && nullableNumber(day.observedCostUsd) && validEstimate(day.costEstimate);
}

function validRun(value: unknown): boolean {
  const run = record(value);
  return run !== null && typeof run.runId === 'string' && typeof run.repo === 'string'
    && EXECUTION_STATES.some(state => state === run.status) && nullableInteger(run.prNumber)
    && typeof run.startedAt === 'string' && nullableNumber(run.durationMs)
    && nullableNumber(run.costUsd) && nullableNumber(run.observedCostUsd) && validEstimate(run.costEstimate)
    && (run.assessment === null || validAssessment(run.assessment, run.runId));
}

function validSummary(value: unknown): value is OutcomeSummary {
  const source = record(value);
  if (!source) return false;
  const window = record(source.window);
  const estimate = record(source.costEstimate);
  return window !== null && typeof window.from === 'string' && typeof window.to === 'string'
    && (source.repo === null || typeof source.repo === 'string')
    && validCounts(source, ['runs', 'runsWithKnownCost', 'runsWithDuration', 'linkedPrs', 'unknownPrs',
      'stalePrs', 'unavailablePrs', 'publishedPrs', 'reviewedPrs', 'mergedPrs'])
    && validCounts(source.execution, EXECUTION_STATES)
    && validCounts(source.assessments, ASSESSMENT_STATES) && validCounts(source.outcomes, TASK_OUTCOMES)
    && ['knownCostUsd', 'observedCostUsd', 'averageCostUsd', 'averageDurationMs', 'costPerPublishedPrUsd',
      'costPerReviewedPrUsd', 'costPerMergedPrUsd'].every(key => nullableNumber(source[key]))
    && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'correctionRounds'].every(key => nullableInteger(source[key]))
    && (source.costCoverage === null || nonNegativeNumber(source.costCoverage) && source.costCoverage <= 1)
    && validEstimate(source.costEstimate)
    && (source.costEstimate === undefined || estimate !== null && nonNegativeInteger(estimate.runsWithoutUsage)
      && typeof estimate.rateSource === 'string' && typeof estimate.ratesAsOf === 'string')
    && Array.isArray(source.failures) && source.failures.every(value => {
      const failure = record(value);
      return failure !== null && typeof failure.stage === 'string' && nonNegativeInteger(failure.count);
    })
    && Array.isArray(source.daily) && source.daily.every(validDay)
    && Array.isArray(source.recentRuns) && source.recentRuns.every(validRun);
}

export async function fetchOutcomes(repo: string | null, days: OutcomeWindow, signal?: AbortSignal): Promise<OutcomeSummary> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(`/api/outcomes?${params}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = record(body)?.error;
    throw new Error(typeof error === 'string' ? error : `Could not load outcomes (${response.status}).`);
  }
  if (!validSummary(body)) throw new Error('Outcomes response was invalid.');
  return body;
}

export interface AssessmentInput {
  state: OutcomeAssessment['state'];
  outcome: OutcomeAssessment['outcome'];
  summary: string;
  evidence: string[];
  failureStage: string | null;
  correctionRounds: number | null;
}

function validAssessment(value: unknown, runId: string): value is OutcomeAssessment {
  const assessment = record(value);
  if (!assessment || assessment.runId !== runId) return false;
  return ASSESSMENT_STATES.some(state => state === assessment.state)
    && TASK_OUTCOMES.some(outcome => outcome === assessment.outcome)
    && typeof assessment.summary === 'string'
    && Array.isArray(assessment.evidence) && assessment.evidence.every(item => typeof item === 'string')
    && (assessment.failureStage === null || typeof assessment.failureStage === 'string')
    && (assessment.correctionRounds === null || typeof assessment.correctionRounds === 'number'
      && Number.isSafeInteger(assessment.correctionRounds) && assessment.correctionRounds >= 0)
    && typeof assessment.updatedAt === 'string' && Number.isFinite(Date.parse(assessment.updatedAt))
    && (assessment.source === undefined || assessment.source === 'manual' || assessment.source === 'telemetry');
}

export async function saveOutcomeAssessment(runId: string, input: AssessmentInput, signal?: AbortSignal): Promise<OutcomeAssessment> {
  const response = await fetch(`/api/outcomes/${encodeURIComponent(runId)}/assessment`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = record(body)?.error;
    throw new Error(typeof error === 'string' ? error : `Could not save assessment (${response.status}).`);
  }
  const assessment = record(body)?.assessment ?? body;
  if (!validAssessment(assessment, runId)) throw new Error('Assessment response was invalid.');
  return assessment;
}

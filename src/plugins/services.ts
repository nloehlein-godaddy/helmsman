import type { AssessmentInput, OutcomeAssessment, OutcomeSummary, OutcomeWindow } from './outcomes';
import type { PricingEstimate, UsageQuery, UsageSnapshot } from './usage';

export interface PluginPageServices {
  readonly version: 1;
  readonly usage: {
    query(input: UsageQuery, signal?: AbortSignal): Promise<UsageSnapshot>;
  };
  readonly outcomes: {
    summary(repo: string | null, days: OutcomeWindow, signal?: AbortSignal): Promise<OutcomeSummary>;
    assessment(runId: string, input: AssessmentInput, signal?: AbortSignal): Promise<OutcomeAssessment>;
  };
  readonly pricing: {
    estimate(input: UsageQuery, signal?: AbortSignal): Promise<PricingEstimate | null>;
  };
}

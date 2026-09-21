import type { CampaignServiceV1 } from './campaigns';
import type { TerminalServiceV1 } from './terminal';
import type { CommunicationServiceV1 } from './communication';
import type { CommunicationCommandServiceV1 } from './communication-command';
import type { PullRequestCommandServiceV1 } from './pull-request-command';
import type { ClarificationReadServiceV1 } from './clarification-read';
import type { ClarificationCommandServiceV1 } from './clarification-command';
import type { SuggestedContactAdminServiceV1 } from './suggested-contact-admin';
import type { SourceAdminServiceV1 } from './source-admin';
import type { TodoLegacyRecoveryServiceV1 } from './todo-legacy-recovery';
import type { AssessmentInput, OutcomeAssessment, OutcomeSummary, OutcomeWindow } from './outcomes';
import type { PricingEstimate, UsageQuery, UsageSnapshot } from './usage';
import type { TaskReadServiceV1 } from './task-read';
import type { RunReadServiceV1 } from './run-read';
import type { RunInspectServiceV1 } from './run-inspect';
import type { DownloadServiceV1 } from './download';
import type { PullRequestReadServiceV1 } from './pull-request-read';
import type { PullRequestInspectServiceV1 } from './pull-request-inspect';
import type { ActivityReadServiceV1 } from './activity-read';
import type { RunCommandServiceV1 } from './run-command';
import type { TaskEditServiceV1 } from './task-edit';
import type { SourceCommandServiceV1 } from './source-command';
import type { TaskViewsReadServiceV1 } from './task-views';

export interface PluginPageServices {
  readonly version: 1;
  readonly tasks?: TaskReadServiceV1;
  readonly taskEdit?: TaskEditServiceV1;
  readonly todoLegacyRecovery?: TodoLegacyRecoveryServiceV1;
  readonly sourceCommands?: SourceCommandServiceV1;
  readonly sourceAdmin?: SourceAdminServiceV1;
  readonly taskViews?: TaskViewsReadServiceV1;
  readonly runs?: RunReadServiceV1;
  readonly runInspect?: RunInspectServiceV1;
  readonly downloads?: DownloadServiceV1;
  readonly clarifications?: ClarificationReadServiceV1;
  readonly clarificationCommands?: ClarificationCommandServiceV1;
  readonly suggestedContacts?: SuggestedContactAdminServiceV1;
  readonly pullRequests?: PullRequestReadServiceV1;
  readonly pullRequestInspect?: PullRequestInspectServiceV1;
  readonly pullRequestCommands?: PullRequestCommandServiceV1;
  readonly communication?: CommunicationServiceV1;
  readonly terminal?: TerminalServiceV1;
  readonly campaigns?: CampaignServiceV1;
  readonly communicationCommands?: CommunicationCommandServiceV1;
  readonly activity?: ActivityReadServiceV1;
  readonly runCommands?: RunCommandServiceV1;
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

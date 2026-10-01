import type { PluginJson } from './backend';
import type { FeedbackCommandInputV1 } from './feedback-command';

export const FEEDBACK_MARKER_TOKEN = '{{helmsman-feedback-marker}}';
export interface FeedbackHttpRequestV1 { readonly method: 'GET' | 'POST'; readonly path: string; readonly query: Readonly<Record<string, string>>; readonly body: PluginJson; }
export interface FeedbackHttpV1 { request(input: FeedbackHttpRequestV1): Promise<{ readonly status: number; readonly body: unknown }>; }
export interface FeedbackTrackerContextV1 { readonly signal: AbortSignal; readonly http: FeedbackHttpV1; }
export interface FeedbackTrackerPlanV1 {
  readonly destination: { readonly id: string; readonly label: string; readonly url: string };
  readonly target: PluginJson;
  readonly request: FeedbackHttpRequestV1;
}
export interface FeedbackSubmissionV1 { readonly id: string; readonly contentHash: string; readonly input: FeedbackCommandInputV1; readonly plan: FeedbackTrackerPlanV1; readonly request: FeedbackHttpRequestV1; }
export type FeedbackTrackerResultV1 =
  | { readonly status: 'acknowledged'; readonly receipt: { readonly id: string; readonly url: string } }
  | { readonly status: 'definitely-not-applied'; readonly retryable: false; readonly reason: string; readonly evidence: PluginJson }
  | { readonly status: 'unknown'; readonly reason: string; readonly evidence: PluginJson };
export interface FeedbackTrackerProviderV1 {
  destination(context: FeedbackTrackerContextV1): Promise<FeedbackTrackerPlanV1['destination'] | null>;
  prepareSubmission(input: FeedbackCommandInputV1, context: FeedbackTrackerContextV1): Promise<FeedbackTrackerPlanV1>;
  invokeSubmission(input: FeedbackSubmissionV1, context: FeedbackTrackerContextV1): Promise<FeedbackTrackerResultV1>;
  reconcileSubmission(input: FeedbackSubmissionV1, context: FeedbackTrackerContextV1): Promise<FeedbackTrackerResultV1>;
}
export interface FeedbackTrackerDeclarationV1 { readonly access: readonly ['connection-http']; }

export interface FeedbackTrackerBackendContextV1 {
  readonly pluginId: string; readonly signal: AbortSignal; readonly settings: Readonly<Record<string, PluginJson>>;
  registerFeedbackTracker?(localId: string, provider: FeedbackTrackerProviderV1): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}

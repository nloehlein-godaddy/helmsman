import type { PullRequestInspectDetailQueryV1, PullRequestInspectDetailV1, PullRequestInspectDiffQueryV1, PullRequestInspectDiffV1 } from './pull-request-inspect';
import type { PullRequestReadItemV1, PullRequestReadQualityV1, PullRequestReadQueryV1 } from './pull-request-read';
import type { ProfileIdentityV1 } from './profile';
import type { PullRequestFeedbackSnapshotV1 } from './pull-request-feedback';

export interface PullRequestProviderBatchV1 {
  readonly items: readonly PullRequestReadItemV1[];
  readonly quality: PullRequestReadQualityV1;
  readonly truncated: boolean;
  readonly browseUrl: string | null;
  readonly notice?: 'github-sso-required';
}

export interface PullRequestHttpV1 {
  request(input: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
    readonly body: unknown | null;
  }): Promise<{ readonly status: number; readonly body: unknown; readonly link?: string; readonly sso?: 'partial' | 'required' }>;
}

export interface PullRequestProviderContextV1 {
  readonly signal: AbortSignal;
  readonly http: PullRequestHttpV1;
  readonly configuredAuthor?: string;
}

export interface PullRequestReviewPreparationV1 {
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly actor: string;
}

export interface PullRequestReviewOperationV1 {
  readonly id: string;
  readonly contentHash: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly actor: string;
  readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  readonly body: string;
}

export function formatPullRequestReviewBody(input: Readonly<{ id: string; contentHash: string; body: string }>): string {
  return `${input.body}${input.body ? '\n\n' : ''}<!-- helmsman-operation:${input.id}:${input.contentHash} -->`;
}

export interface PullRequestReviewOperationResultV1 {
  readonly status: 'acknowledged' | 'definitely-not-applied' | 'unknown';
  readonly retryable?: boolean;
  readonly reason?: string;
  readonly receipt?: unknown;
  readonly evidence?: unknown;
}

export interface PullRequestProviderV1 {
  feedbackSnapshot?(input: PullRequestInspectDetailQueryV1, context: PullRequestProviderContextV1): Promise<PullRequestFeedbackSnapshotV1>;
  profile?(context: PullRequestProviderContextV1): Promise<ProfileIdentityV1>;
  list(input: { readonly query: PullRequestReadQueryV1; readonly repos: readonly string[] }, context: PullRequestProviderContextV1): Promise<PullRequestProviderBatchV1>;
  detail(input: PullRequestInspectDetailQueryV1, context: PullRequestProviderContextV1): Promise<PullRequestInspectDetailV1>;
  diff(input: PullRequestInspectDiffQueryV1, context: PullRequestProviderContextV1): Promise<PullRequestInspectDiffV1>;
  prepareReview(input: { readonly repo: string; readonly number: number; readonly expectedHeadSha: string | null }, context: PullRequestProviderContextV1): Promise<PullRequestReviewPreparationV1>;
  invokeReview(input: PullRequestReviewOperationV1, context: PullRequestProviderContextV1): Promise<PullRequestReviewOperationResultV1>;
  reconcileReview(input: PullRequestReviewOperationV1, context: PullRequestProviderContextV1): Promise<PullRequestReviewOperationResultV1>;
}

export interface PullRequestProviderDeclaration {
  readonly access: readonly ['core-http'];
}

export interface CommunicationDestinationV1 {
  readonly providerId: string;
  readonly artifactHash: string;
  readonly workspace: string;
  readonly channel: string;
  readonly mention: string;
  readonly connectionId: string;
}


export interface CommunicationReviewRequestV1 {
  readonly id: string;
  readonly contentHash: string;
  readonly caller: string;
  readonly requestId: string;
  readonly repo: string;
  readonly number: number;
  readonly destination: CommunicationDestinationV1;
}

export interface CommunicationBrowserSessionV1 {
  tree(): Promise<unknown>;
  focus(input: { readonly surface: string }): Promise<void>;
  evaluate(input: { readonly surface: string; readonly script: string }): Promise<unknown>;
  click(input: { readonly surface: string; readonly selector: string }): Promise<void>;
  fill(input: { readonly surface: string; readonly selector: string; readonly value: string }): Promise<void>;
  wait(input: { readonly surface: string; readonly selector: string; readonly timeoutMs: number }): Promise<void>;
}

export interface CommunicationProviderContextV1 {
  readonly signal: AbortSignal;
  readonly destination: CommunicationDestinationV1;
  readonly surface: string | null;
  readonly watchedChannel: { readonly id: string; readonly name: string };
  readonly browser: CommunicationBrowserSessionV1;
  beforeSend(): Promise<void>;
}

export type CommunicationProviderResultV1 =
  | { readonly status: 'acknowledged'; readonly receipt: { readonly workspace: string; readonly channel: string; readonly mention: string; readonly connectionId: string; readonly permalink: string | null } }
  | { readonly status: 'definitely-not-applied'; readonly retryable: boolean; readonly reason: string; readonly evidence: unknown }
  | { readonly status: 'unknown'; readonly reason: string; readonly evidence: unknown };

export interface CommunicationProviderV1 {
  connectionIdentity?(): string | null;
  prepareReviewRequest(input: { readonly repo: string; readonly number: number }, context: CommunicationProviderContextV1): Promise<Pick<CommunicationDestinationV1, 'workspace' | 'channel' | 'mention' | 'connectionId'>>;
  invokeReviewRequest(input: CommunicationReviewRequestV1, context: CommunicationProviderContextV1): Promise<CommunicationProviderResultV1>;
  reconcileReviewRequest(input: CommunicationReviewRequestV1, context: CommunicationProviderContextV1): Promise<CommunicationProviderResultV1>;
  scanReviewRequests(input: { readonly since: string | null }, context: CommunicationProviderContextV1): Promise<{ readonly messages: readonly { readonly channelId: string; readonly ts: string; readonly permalink: string; readonly author: string; readonly prUrls: readonly string[] }[]; readonly complete: boolean }>;
}

export interface CommunicationProviderDeclaration { readonly access: readonly ['browser-session'] | readonly ['provider-network']; }

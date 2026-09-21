import { describe, expect, it } from 'vitest';
import type { PluginJson } from '../backend';
import type { WebhookTriggerInputV1 } from '../trigger';
import { githubWebhookTriggerProvider, parseGithubWebhookRoutes } from './provider';

const routes = parseGithubWebhookRoutes(JSON.stringify([
  { repo: 'Org/Repo', event: 'issues', action: 'opened', workflowRef: 'coding@1' },
  { repo: 'org/repo', event: 'pull_request', action: 'review_requested', workflowRef: 'review@1' },
]));
function input(event: string, body: PluginJson): WebhookTriggerInputV1 {
  return { version: 1, deliveryId: 'delivery-1', event, body };
}

describe('GitHub webhook trigger', () => {
  it('maps authenticated issue and pull-request events to configured intents', () => {
    const provider = githubWebhookTriggerProvider({ enabled: true, routes });
    expect(provider.parse(input('issues', { action: 'opened', repository: { full_name: 'org/repo' }, issue: { number: 7, title: 'Fix inventory', body: 'Reject negatives.' } }))).toEqual({
      workflowRef: 'coding@1', intent: { mode: 'freeform', repo: 'org/repo', title: 'Fix inventory', task: 'Fix inventory\n\nReject negatives.' },
    });
    expect(provider.parse(input('pull_request', { action: 'review_requested', repository: { full_name: 'org/repo' }, pull_request: { number: 42, title: 'Review inventory' } }))).toEqual({
      workflowRef: 'review@1', intent: { mode: 'review', repo: 'org/repo', title: 'Review inventory', prNumber: 42 },
    });
  });

  it('ignores unconfigured, malformed, and disabled events', () => {
    const configured = githubWebhookTriggerProvider({ enabled: true, routes });
    expect(configured.parse(input('issues', { action: 'closed', repository: { full_name: 'org/repo' } }))).toBeNull();
    expect(configured.parse(input('issues', { action: 'opened', repository: { full_name: 'other/repo' }, issue: { number: 1, title: 'Other' } }))).toBeNull();
    expect(githubWebhookTriggerProvider({ enabled: false, routes }).parse(input('issues', {}))).toBeNull();
  });

  it('declares GitHub HMAC ingress and rejects ambiguous route settings', () => {
    expect(githubWebhookTriggerProvider({ enabled: true, routes }).metadata.ingress).toEqual({
      signatureHeader: 'x-hub-signature-256', deliveryHeader: 'x-github-delivery', eventHeader: 'x-github-event', algorithm: 'hmac-sha256', signaturePrefix: 'sha256=',
    });
    expect(() => parseGithubWebhookRoutes(JSON.stringify([
      { repo: 'org/repo', event: 'issues', action: 'opened', workflowRef: 'coding@1' },
      { repo: 'ORG/REPO', event: 'issues', action: 'opened', workflowRef: 'coding@1' },
    ]))).toThrow('Duplicate GitHub webhook route');
    expect(() => parseGithubWebhookRoutes('[{"repo":"org/repo","event":"issues","action":"opened","workflowRef":"review@1"}]')).toThrow('Invalid GitHub webhook workflow mapping');
  });
});

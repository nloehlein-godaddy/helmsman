import type { WebhookTriggerInputV1, WebhookTriggerProviderV1 } from '@helmsman/plugin-sdk';

export interface GithubWebhookRoute {
  readonly repo: string;
  readonly event: 'issues' | 'pull_request';
  readonly action: 'opened' | 'labeled' | 'synchronize' | 'review_requested' | 'reopened';
  readonly workflowRef: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function repo(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(value) ? value.toLowerCase() : null;
}

function workflowRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && (value === 'coding@1' || value === 'review@1'
    || /^(?:[a-z][a-z\d-]{0,63}\.)+[a-z][a-z\d-]{0,63}\/[a-z][a-z\d-]{0,63}(?:@1)?$/.test(value));
}

export function parseGithubWebhookRoutes(value: string): readonly GithubWebhookRoute[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 100) throw new TypeError('Invalid GitHub webhook routes');
  const routes = parsed.map(input => {
    const item = record(input);
    const routeRepo = repo(item?.repo);
    if (!item || Object.keys(item).some(key => !['repo', 'event', 'action', 'workflowRef'].includes(key)) || !routeRepo
      || item.event !== 'issues' && item.event !== 'pull_request'
      || !['opened', 'labeled', 'synchronize', 'review_requested', 'reopened'].includes(String(item.action))
      || !workflowRef(item.workflowRef)) throw new TypeError('Invalid GitHub webhook routes');
    if (item.event === 'issues' && item.workflowRef === 'review@1' || item.event === 'pull_request' && item.workflowRef === 'coding@1') {
      throw new TypeError('Invalid GitHub webhook workflow mapping');
    }
    return { repo: routeRepo, event: item.event, action: item.action, workflowRef: item.workflowRef } as GithubWebhookRoute;
  });
  const keys = routes.map(route => `${route.repo}\u0000${route.event}\u0000${route.action}`);
  if (new Set(keys).size !== keys.length) throw new TypeError('Duplicate GitHub webhook route');
  return routes;
}

function parseEntity(input: WebhookTriggerInputV1, route: GithubWebhookRoute): { title: string; number: number; body: string } | null {
  const body = record(input.body);
  const entity = record(body?.[route.event === 'issues' ? 'issue' : 'pull_request']);
  if (!entity || typeof entity.title !== 'string' || !entity.title.trim() || entity.title.length > 1000
    || !Number.isSafeInteger(entity.number) || Number(entity.number) < 1) return null;
  return { title: entity.title, number: Number(entity.number), body: typeof entity.body === 'string' ? entity.body.slice(0, 98_000) : '' };
}

export function githubWebhookTriggerProvider(settings: { readonly enabled: boolean; readonly routes: readonly GithubWebhookRoute[] }): WebhookTriggerProviderV1 {
  return {
    metadata: {
      version: 1,
      label: 'GitHub webhook',
      kind: 'webhook',
      ingress: {
        signatureHeader: 'x-hub-signature-256',
        deliveryHeader: 'x-github-delivery',
        eventHeader: 'x-github-event',
        algorithm: 'hmac-sha256',
        signaturePrefix: 'sha256=',
      },
    },
    parse(input) {
      if (!settings.enabled) return null;
      const body = record(input.body);
      const eventRepo = repo(record(body?.repository)?.full_name);
      const action = body?.action;
      if (!eventRepo || typeof action !== 'string') return null;
      const route = settings.routes.find(value => value.repo === eventRepo && value.event === input.event && value.action === action);
      if (!route) return null;
      const entity = parseEntity(input, route);
      if (!entity) return null;
      return route.event === 'pull_request'
        ? { workflowRef: route.workflowRef, intent: { mode: 'review', repo: route.repo, title: entity.title, prNumber: entity.number } }
        : { workflowRef: route.workflowRef, intent: { mode: 'freeform', repo: route.repo, title: entity.title, task: `${entity.title}\n\n${entity.body}` } };
    },
  };
}

import { vi } from 'vitest';
import type { CommunicationCommandInputV1, CommunicationCommandPendingV1, CommunicationCommandReceiptV1, CommunicationNotificationsV1, CommunicationSettingsSnapshotV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '../sdk';
export const available = <T>(value: T) => ({ status: 'available' as const, value });
export const snapshot: CommunicationSettingsSnapshotV1 = { version: 1, revision: 'revision-1', values: { enabled: true, watchEnabled: true, clientId: 'workspace', channelId: 'C001', channelName: 'reviews', browserSurface: '', reviewChannel: 'reviews', reviewMention: '@team' }, destination: { providerId: 'helmsman.slack/reviews', artifactHash: 'a'.repeat(64), workspace: 'workspace', channel: 'reviews', mention: '@team', connectionId: 'connection' } };
export const notifications: CommunicationNotificationsV1 = { version: 1, quality: 'complete', unread: 1, health: { enabled: true, status: 'healthy', channelName: 'reviews', intervalMs: 120_000, lastSuccessAt: '2026-09-20T12:00:00Z', error: null }, githubHealth: null, notifications: [{ id: 'notification-1', repo: 'org/b', prNumber: 42, prUrl: 'https://github.com/org/b/pull/42', sourceUrl: 'https://team.slack.com/archives/C001/p1234', author: 'Writer', channelName: 'reviews', status: 'launched', runId: 'run-1', createdAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-20T12:00:00Z', readAt: null, error: null }] };
export const requestId = 'b0ef36b8-e7a2-4b24-a343-2dac4b561824';
export const terminal = (input: CommunicationCommandInputV1): CommunicationCommandReceiptV1 => ({ version: 1, requestId, input, status: 'succeeded', reason: null, result: { repo: input.repo, number: input.number, destination: input.expectedDestination, permalink: 'https://team.slack.com/archives/C001/p1234' } });
export const lifetimes: AbortController[] = [];
export async function fixture(module: PluginPanelModule, overrides: Partial<PluginPanelState> = {}, configure?: (context: PluginPanelContext) => void, contributionId = 'helmsman.communication/review-request') {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime);
  let state: PluginPanelState = { repo: 'org/b', headerRepo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'request', savedState: null, activity: { epoch: 1, signal: new AbortController().signal, active: true, repo: 'org/b' }, pullRequest: { version: 1, repo: 'org/b', number: 42, mode: null }, ...overrides };
  const pending: CommunicationCommandPendingV1[] = [];
  const context: PluginPanelContext = { contributionId, state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), selectPresentation: vi.fn(), saveState: vi.fn(async () => {}), services: { version: 1,
    communication: { version: 1, notifications: vi.fn(async () => available(notifications)), markRead: vi.fn(async input => available({ version: 1 as const, id: input.id, readAt: '2026-09-20T12:01:00Z' })), settings: vi.fn(async () => available(snapshot)), saveSettings: vi.fn(async input => available({ ...snapshot, revision: 'revision-2', values: input.values })) },
    communicationCommands: { version: 1, submit: vi.fn(), retry: vi.fn(), receipt: vi.fn(), pending: vi.fn(async () => [...pending]), acknowledge: vi.fn(async input => { const index = pending.findIndex(item => item.command.requestId === input.requestId); if (index >= 0) pending.splice(index, 1); }) },
  } };
  let instance: PluginPanelInstance;
  Object.assign(context, { setScope: vi.fn<NonNullable<PluginPanelContext['setScope']>>(async scope => { const repo = scope.kind === 'galleon' ? scope.repo : scope.kind === 'all' ? null : state.headerRepo ?? null; state = { ...state, repo, activity: { epoch: state.activity.epoch + 1, signal: new AbortController().signal, active: true, repo } }; await instance?.update(state); }) });
  configure?.(context); instance = await module.mount(container, context);
  return { container, lifetime, context, instance, state: () => state, pending };
}
export function fill(container: HTMLElement, selector: string, value: string) { const control = container.querySelector<HTMLInputElement>(selector)!; control.focus(); control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); }
export function click(container: HTMLElement, selector: string) { container.querySelector<HTMLButtonElement>(selector)!.click(); }

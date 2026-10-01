import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExecutionPolicySnapshotV1, ExecutionPolicyCommandV1, PluginPanelContext, PluginPanelState } from '@helmsman/plugin-sdk';
import panel from './panel';
const snapshot: ExecutionPolicySnapshotV1 = { version: 1, repo: 'org/b', policy: { version: 1, repo: 'org/b', revision: 0, maxConcurrentRuns: 1 },
  limits: { globalMaxConcurrentRuns: 4, perRunCostCapUsd: 2.5, activeRuns: 1 }, readiness: { currentVersion: 2, targetVersion: 2, ready: true, blockers: [] } };
const available = <T>(value: T) => ({ status: 'available' as const, value });
const controllers: AbortController[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => { controllers.splice(0).forEach(value => value.abort()); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function fixture(value = snapshot) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); controllers.push(lifetime);
  const state: PluginPanelState = { repo: 'org/b', headerRepo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'settings', savedState: null,
    activity: { epoch: 1, signal: new AbortController().signal, active: true, repo: 'org/b' } };
  const service = { version: 1 as const, read: vi.fn(async () => available(value)), set: vi.fn(async (input: ExecutionPolicyCommandV1) => available({ version: 1 as const, repo: input.repo, revision: input.expectedRevision + 1, maxConcurrentRuns: input.maxConcurrentRuns })) };
  const context: PluginPanelContext = { contributionId: 'helmsman.execution-settings/panel', state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), saveState: vi.fn(async () => {}), services: { version: 1, executionPolicy: service } };
  const instance = await panel.mount(container, context); await vi.waitFor(() => expect(container.querySelector('input[type=number]')).not.toBeNull());
  return { container, context, state, service, instance, lifetime };
}
function button(container: HTMLElement, text: string) { return [...container.querySelectorAll('button')].find(item => item.textContent === text)!; }
function select(container: HTMLElement, value: number) { const input = container.querySelector<HTMLInputElement>('input[type=number]')!; input.value = String(value); input.dispatchEvent(new Event('change')); }
it('requires explicit opt-in after showing limits and keeps the header scope unchanged', async () => {
  const f = await fixture(); expect(f.service.read).toHaveBeenCalledWith({ version: 1, repo: 'org/b' });
  expect(f.container.textContent).toContain('Global limit: 4'); expect(f.container.textContent).toContain('Per-run cost cap: $2.50');
  select(f.container, 3); expect(button(f.container, 'Save execution settings').disabled).toBe(true);
  f.container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); button(f.container, 'Save execution settings').click();
  await vi.waitFor(() => expect(f.service.set).toHaveBeenCalledOnce());
  expect(f.service.set.mock.calls[0]?.[0]).toMatchObject({ repo: 'org/b', expectedRevision: 0, maxConcurrentRuns: 3 });
  expect(f.context.navigate).not.toHaveBeenCalled(); expect(f.state.headerRepo).toBe('org/a');
});
it('retains an uncertain request across remount and retries its original ID and revision', async () => {
  const f = await fixture(); f.service.set.mockRejectedValueOnce(new Error('response lost')); button(f.container, 'Save execution settings').click();
  await vi.waitFor(() => expect(f.container.textContent).toContain('Delivery could not be confirmed'));
  const original = f.service.set.mock.calls[0]?.[0]; f.lifetime.abort();
  const next = await fixture({ ...snapshot, policy: { ...snapshot.policy, revision: 2 } }); button(next.container, 'Retry saved change').click();
  await vi.waitFor(() => expect(next.service.set).toHaveBeenCalledExactlyOnceWith(original));
});
it('shows retained migration blockers and prevents parallel opt-in before schema readiness', async () => {
  const f = await fixture({ ...snapshot, readiness: { currentVersion: 1, targetVersion: 2, ready: false, blockers: [{ source: 'execution-snapshot', identity: 'run-old', range: { owner: 'core.execution', minimum: 1, maximum: 1 } }] } });
  expect(f.container.textContent).toContain('run-old'); select(f.container, 2); f.container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  expect(button(f.container, 'Save execution settings').disabled).toBe(true); expect(f.service.set).not.toHaveBeenCalled();
});
it('does not send when the request cannot be persisted locally', async () => {
  const f = await fixture(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); }); button(f.container, 'Save execution settings').click();
  expect(f.service.set).not.toHaveBeenCalled(); expect(f.container.textContent).toContain('No change was sent');
});

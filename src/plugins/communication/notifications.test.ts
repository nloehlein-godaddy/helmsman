import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import header from './header';
import panel from './notifications';
import { available, click, fixture, lifetimes, notifications } from './fixtures.test-support';
import type { CommunicationNotificationsV1, CommunicationReviewNotificationV1, PluginPageContext, PluginPageModule, PluginPanelContext, PluginPanelModule } from '../sdk';
const headerPanel: PluginPanelModule = { mount: (container, context) => header.mount(container, context as unknown as PluginPageContext) };
const item = notifications.notifications[0]! as CommunicationReviewNotificationV1;
beforeEach(() => localStorage.clear());
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function setup(data = notifications, pirateMode = false, configure?: (context: PluginPanelContext) => void, module = headerPanel) { const f = await fixture(module, { pirateMode }, context => { vi.mocked(context.services.communication!.notifications).mockResolvedValue(available(data)); configure?.(context); }); await f.instance.refresh?.(); return f; }
it.each([true, false])('preserves completed run status, links, dates and terminology (pirate=%s)', async pirate => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-20T12:15:00Z'));
  const data: CommunicationNotificationsV1 = { ...notifications, notifications: (['succeeded', 'failed', 'stopped'] as const).map(status => ({ ...item, kind: 'voyage-completed', id: status, title: 'Fix task switching', status, runId: 'run-42', sourceUrl: '/runs?run=run-42', error: null, updatedAt: '2026-09-20T12:10:00Z' })) };
  const f = await setup(data, pirate); expect([...f.container.querySelectorAll('.slack-status')].map(node => node.textContent)).toEqual(pirate ? ['Shipshape', 'Marooned', 'Stopped'] : ['Succeeded', 'Failed', 'Stopped']); expect(f.container.querySelector('.slack-voyage-title')?.textContent).toBe('Fix task switching'); expect(f.container.querySelector('.slack-author')?.textContent).toBe(`${pirate ? 'Voyage' : 'Run'} · org/b`); expect(f.container.querySelector('.app-link')?.textContent).toBe(pirate ? 'View voyage' : 'View run'); expect(f.container.querySelector('time')?.textContent).toBe('5m ago'); expect(f.container.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-20T12:10:00Z'); expect(f.container.querySelector('a[target="_blank"]')?.textContent).toBe(pirate ? 'Bounty #42' : 'PR #42');
});
it.each([true, false])('preserves review failure terminology without rewriting external text (%s)', async pirate => {
  const f = await setup({ ...notifications, notifications: [{ ...item, status: 'failed', channelName: 'Helmsman created PRs', sourceUrl: '/runs?run=parent-42', error: 'PR review failed for agent in galleon', model: 'agent-review-model' }] }, pirate);
  expect(f.container.querySelector('.slack-status')?.textContent).toBe(pirate ? 'Inspection: Marooned' : 'Review: Failed'); expect(f.container.querySelector('.slack-author')?.textContent).toBe(`Helmsman ${pirate ? 'inspection' : 'review'} · newly opened ${pirate ? 'Bounty' : 'PR'}`); expect(f.container.querySelector('.slack-notification .slack-error')?.textContent).toBe('PR review failed for agent in galleon'); expect(f.container.querySelector('.slack-routing')?.textContent).toBe('agent-review-model'); const original = [...f.container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent === (pirate ? 'Original voyage' : 'Original run'))!; expect(new URL(original.href).searchParams.get('runRepo')).toBe('org/b'); expect(new URL(original.href).searchParams.get('repo')).toBe('org/a');
});
it('distinguishes review states and read history, and links only launched or failed runs', async () => {
  const f = await setup({ ...notifications, notifications: (['launched', 'queued', 'failed', 'blocked'] as const).map(status => ({ ...item, id: status, status, readAt: status === 'queued' ? item.createdAt : null })) }, true);
  expect([...f.container.querySelectorAll('.slack-status')].map(node => node.textContent)).toEqual(['Inspection started', 'Inspection queued', 'Inspection: Marooned', 'Inspection blocked']); expect(f.container.querySelector('[data-notification-id="queued"] .app-link')).toBeNull(); expect(f.container.querySelector('[data-notification-id="blocked"] .app-link')).toBeNull(); expect(f.container.querySelector('[data-notification-id="failed"] .app-link')).not.toBeNull(); expect(f.container.querySelector('[data-notification-id="queued"] .slack-read')?.textContent).toBe('Read'); expect(f.container.querySelectorAll('[data-slack-read]')).toHaveLength(3);
});
it('escapes external content and rejects unsafe or unrelated source links', async () => {
  const f = await setup({ ...notifications, notifications: [{ ...item, author: '<script>bad()</script>', error: '<img src=x onerror=bad()>', sourceUrl: 'https://github.com/other/repo/pull/42', model: '<img src=x onerror=bad()>' }, { ...item, kind: 'voyage-completed', id: 'completed', title: '<img src=x onerror=bad()>', status: 'succeeded', runId: 'run-42', error: null, prUrl: 'https://evil.test/org/b/pull/42', sourceUrl: 'javascript:bad()' }] });
  expect(f.container.querySelector('img,script,a[href^="javascript:"]')).toBeNull(); expect(f.container.querySelector('.slack-author')?.textContent).toContain('<script>bad()</script>'); expect(f.container.querySelector('.slack-routing')?.textContent).toContain('<img'); expect(f.container.querySelector('.slack-notification-actions a[target="_blank"]')).toBeNull(); expect(f.container.querySelector('.slack-voyage-title')?.textContent).toBe('<img src=x onerror=bad()>');
});
it('shows separate source health and model routing, with safe GitHub request links', async () => {
  const f = await setup({ ...notifications, githubHealth: { ...notifications.health, channelName: 'GitHub requested reviews' }, notifications: [{ ...item, sourceUrl: item.prUrl, channelName: 'GitHub requested reviews', model: 'gpt-5.6-sol', effort: 'medium', complexity: 'low' }] }, true);
  const health = [...f.container.querySelectorAll('.slack-health')]; expect(health[0]?.textContent).toContain('Slack #reviews'); expect(health[1]?.textContent).toContain('GitHub requested inspections'); expect(health.every(node => node.textContent?.includes('Scanning every 2 min'))).toBe(true); expect(f.container.querySelector('.slack-routing')?.textContent).toBe('low complexity · gpt-5.6-sol · medium effort'); expect(f.container.querySelector('.slack-notification-actions a[target="_blank"]')?.getAttribute('href')).toBe(item.prUrl);
});
it('preserves independent header and explicit notification scope and prevents cross-scope responses', async () => {
  const f = await setup(); expect(f.context.services.communication!.notifications).toHaveBeenCalledWith({ version: 1, repo: 'org/b', limit: 256 }, expect.any(AbortSignal)); const run = f.container.querySelector<HTMLAnchorElement>('.app-link')!; expect(new URL(run.href).searchParams.get('repo')).toBe('org/a'); expect(new URL(run.href).searchParams.get('runRepo')).toBe('org/b');
  const service = f.context.services.communication!; vi.mocked(service.notifications).mockResolvedValue(available({ ...notifications, notifications: [{ ...item, repo: 'other/repo' }] })); await f.instance.refresh?.(); expect(f.container.textContent).toContain('retained notifications'); expect(f.container.textContent).not.toContain('other/repo'); await f.instance.update({ ...f.state(), repo: 'org/c' }); await f.instance.refresh?.(); expect(f.container.querySelectorAll('.slack-notification')).toHaveLength(0);
});
it('preserves header default including All in notification panel communication links', async () => {
  const f = await setup(notifications, false, undefined, panel); const link = () => [...f.container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent?.includes('Communication settings'))!; expect(new URL(link().href).searchParams.get('repo')).toBe('org/a'); await f.instance.update({ ...f.state(), headerRepo: null }); expect(new URL(link().href).searchParams.has('repo')).toBe(false);
});
it('provides accessible disclosure, Escape focus return and outside-click dismissal', async () => {
  const f = await setup(); const toggle = () => f.container.querySelector<HTMLButtonElement>('[data-slack-toggle]')!; expect(toggle().getAttribute('aria-expanded')).toBe('false'); expect(toggle().getAttribute('aria-controls')).toBe(f.container.querySelector('.slack-popover')?.id); expect(toggle().getAttribute('aria-label')).toBe('Notifications, 1 unread'); click(f.container, '[data-slack-toggle]'); expect(toggle().getAttribute('aria-expanded')).toBe('true'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(toggle().getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(toggle()); click(f.container, '[data-slack-toggle]'); document.body.click(); expect(toggle().getAttribute('aria-expanded')).toBe('false');
});
it('keeps unread totals unknown for partial reads and removes unread signaling after confirmed reads', async () => {
  const f = await setup({ ...notifications, quality: 'partial', unread: null }); expect(f.container.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('unread count unavailable'); expect(f.container.textContent).toContain('results are incomplete'); vi.mocked(f.context.services.communication!.notifications).mockResolvedValue(available({ ...notifications, unread: 0, notifications: [{ ...item, readAt: item.createdAt }] })); await f.instance.refresh?.(); expect(f.container.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 0 unread'); expect(f.container.querySelector('.has-unread, .slack-count')).toBeNull();
});
it('retains notification history and scroll through mark-read failure', async () => {
  const f = await setup(); click(f.container, '[data-slack-toggle]'); const popover = f.container.querySelector<HTMLElement>('.slack-popover')!; popover.scrollTop = 125; vi.mocked(f.context.services.communication!.markRead).mockResolvedValue({ status: 'unavailable', reason: 'connection-failed' }); click(f.container, '[data-slack-read]'); await vi.waitFor(() => expect(f.container.textContent).toContain('Could not mark notification read')); expect(f.container.querySelector('.slack-popover')?.scrollTop).toBe(125); expect(f.container.querySelectorAll('[data-slack-read]')).toHaveLength(1);
});
it('does not cancel explicit mark-read during polling, but cancels it on hide and ignores late results', async () => {
  let resolve!: (value: ReturnType<typeof available<{ version: 1; id: string; readAt: string }>>) => void; const pending = new Promise<ReturnType<typeof available<{ version: 1; id: string; readAt: string }>>>(done => { resolve = done; });
  const f = await setup(notifications, false, context => { vi.mocked(context.services.communication!.markRead).mockReturnValue(pending); }); click(f.container, '[data-slack-toggle]'); click(f.container, '[data-slack-read]'); const signal = vi.mocked(f.context.services.communication!.markRead).mock.calls[0]![1]!; await f.instance.refresh?.(); expect(signal.aborted).toBe(false); await f.instance.update({ ...f.state(), visible: false }); expect(signal.aborted).toBe(true); resolve(available({ version: 1, id: item.id, readAt: item.createdAt })); await Promise.resolve(); expect(f.container.querySelector('.slack-read')).toBeNull();
});
it('stops polling on hide and lifetime disposal and ignores stale read races', async () => {
  vi.useFakeTimers(); const f = await setup(); const service = f.context.services.communication!; await vi.advanceTimersByTimeAsync(15_000); const reads = vi.mocked(service.notifications).mock.calls.length; expect(reads).toBeGreaterThan(2); await f.instance.update({ ...f.state(), visible: false }); await vi.advanceTimersByTimeAsync(30_000); expect(service.notifications).toHaveBeenCalledTimes(reads);
  await f.instance.update(f.state()); await vi.advanceTimersByTimeAsync(0); const visibleReads = vi.mocked(service.notifications).mock.calls.length; f.lifetime.abort(); await vi.advanceTimersByTimeAsync(30_000); expect(service.notifications).toHaveBeenCalledTimes(visibleReads);
});
it('rejects malformed service notification rows without crashing retained rendering', async () => {
  const f = await setup(); vi.mocked(f.context.services.communication!.notifications).mockResolvedValue(available({ ...notifications, notifications: [{ ...item, channelName: null }] } as unknown as CommunicationNotificationsV1)); await f.instance.refresh?.(); expect(f.container.textContent).toContain('retained notifications'); expect(f.container.querySelectorAll('.slack-notification')).toHaveLength(1);
});
it('declares missing public communication capability before mounting', async () => {
  await expect(fixture(panel, {}, context => { delete (context.services as { communication?: unknown }).communication; })).rejects.toThrow('version 1 communication'); expect((header as PluginPageModule).mount).toBeTypeOf('function');
});
it('retains mounted header controls, disclosure state, focus and scroll through refresh and updates', async () => {
  const f = await setup(); const toggle = f.container.querySelector<HTMLButtonElement>('[data-slack-toggle]')!; const popover = f.container.querySelector<HTMLElement>('.slack-popover')!; toggle.click(); popover.scrollTop = 40;
  const assertMounted = () => { expect(f.container.querySelector('[data-slack-toggle]')).toBe(toggle); expect(f.container.querySelector('.slack-popover')).toBe(popover); expect(popover.scrollTop).toBe(40); };
  await f.instance.refresh?.(); await f.instance.update({ ...f.state(), themeId: 'light' }); assertMounted(); expect(popover.hidden).toBe(false); expect(document.activeElement).toBe(toggle);
  vi.mocked(f.context.services.communication!.notifications).mockResolvedValue(available({ ...notifications, unread: 2, notifications: [item, { ...item, id: 'second' }] })); await f.instance.refresh?.(); assertMounted(); expect(toggle.getAttribute('aria-label')).toBe('Notifications, 2 unread'); expect(popover.querySelectorAll('.slack-notification')).toHaveLength(2); expect(document.activeElement).toBe(toggle);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); assertMounted(); expect(popover.hidden).toBe(true); toggle.click(); assertMounted(); expect(popover.hidden).toBe(false); document.body.click(); assertMounted(); expect(popover.hidden).toBe(true);
  const other = document.createElement('button'); document.body.append(other); other.focus(); await f.instance.refresh?.(); assertMounted(); expect(document.activeElement).toBe(other);
});
it('requests the full supported history so older notifications beyond the first 50 remain readable', async () => {
  const history: CommunicationNotificationsV1 = { ...notifications, unread: 120, notifications: Array.from({ length: 120 }, (_, index) => ({ ...item, id: `history-${index}`, author: `Writer ${index}` })) };
  const f = await setup(notifications, false, context => { vi.mocked(context.services.communication!.notifications).mockImplementation(async query => available({ ...history, notifications: history.notifications.slice(0, query.limit) })); });
  expect(f.context.services.communication!.notifications).toHaveBeenCalledWith({ version: 1, repo: 'org/b', limit: 256 }, expect.any(AbortSignal)); expect(f.container.querySelectorAll('.slack-notification')).toHaveLength(120); click(f.container, '[data-slack-toggle]'); click(f.container, '[data-slack-read="history-119"]'); await vi.waitFor(() => expect(f.context.services.communication!.markRead).toHaveBeenCalledWith({ repo: 'org/b', id: 'history-119' }, expect.any(AbortSignal)));
});

it('offers clear only when supported and disables an empty history', async () => {
  const legacy = await setup(); expect(legacy.container.querySelector('[data-clear-notifications]')).toBeNull();
  const empty = await setup({ ...notifications, clearToken: '0:cutoff', unread: 0, notifications: [] }, false, context => {
    context.services.communication!.clearNotifications = vi.fn();
  });
  expect(empty.container.querySelector<HTMLButtonElement>('[data-clear-notifications]')?.disabled).toBe(true);
  expect(empty.container.textContent).toContain('No notifications yet');
});

it('clears the captured scope, blocks duplicates while busy and retains notifications arriving after its cutoff', async () => {
  let complete!: (value: ReturnType<typeof available<import('../sdk').CommunicationClearReceiptV1>>) => void;
  const pending = new Promise<ReturnType<typeof available<import('../sdk').CommunicationClearReceiptV1>>>(resolve => { complete = resolve; });
  const f = await setup({ ...notifications, clearToken: '1:cutoff' }, false, context => { context.services.communication!.clearNotifications = vi.fn(() => pending); });
  const service = f.context.services.communication!; click(f.container, '[data-slack-toggle]'); click(f.container, '[data-clear-notifications]');
  expect(service.clearNotifications).toHaveBeenCalledWith({ version: 1, repo: 'org/b', clearToken: '1:cutoff' }, expect.any(AbortSignal));
  expect(f.container.querySelector<HTMLButtonElement>('[data-clear-notifications]')?.disabled).toBe(true);
  expect(f.container.querySelector('.slack-popover')?.getAttribute('aria-busy')).toBe('true');
  click(f.container, '[data-clear-notifications]'); await f.instance.refresh?.(); expect(service.clearNotifications).toHaveBeenCalledTimes(1);
  const next = { ...item, id: 'arrival', author: 'Arrived after capture' };
  vi.mocked(service.notifications).mockResolvedValue(available({ ...notifications, clearToken: '2:cutoff', notifications: [next] }));
  complete(available({ version: 1, repo: 'org/b', clearToken: '1:cutoff', cleared: 100 }));
  await vi.waitFor(() => expect(f.container.querySelector('[data-notification-id="arrival"]')).not.toBeNull());
  expect(f.container.querySelector('[data-notification-id="notification-1"]')).toBeNull();
  expect(f.container.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
});

it('keeps clear failures visible across polling and retries the original cutoff without clearing later arrivals', async () => {
  const f = await setup({ ...notifications, clearToken: '1:cutoff' }, false, context => {
    context.services.communication!.clearNotifications = vi.fn(async () => ({ status: 'unavailable' as const, reason: 'connection-failed' as const }));
  });
  const service = f.context.services.communication!; click(f.container, '[data-slack-toggle]'); click(f.container, '[data-clear-notifications]');
  await vi.waitFor(() => expect(f.container.textContent).toContain('Could not clear notifications'));
  const arrival = { ...item, id: 'arrival', author: 'New notification' };
  vi.mocked(service.notifications).mockResolvedValue(available({ ...notifications, clearToken: '2:cutoff', unread: 2, notifications: [item, arrival] }));
  await f.instance.refresh?.(); expect(f.container.textContent).toContain('Could not clear notifications');
  vi.mocked(service.clearNotifications!).mockResolvedValue(available({ version: 1, repo: 'org/b', clearToken: '1:cutoff', cleared: 1 }));
  vi.mocked(service.notifications).mockResolvedValue({ status: 'unavailable', reason: 'connection-failed' });
  click(f.container, '[data-clear-notifications]');
  await vi.waitFor(() => expect(f.container.querySelectorAll('.slack-notification')).toHaveLength(1));
  expect(service.clearNotifications).toHaveBeenLastCalledWith({ version: 1, repo: 'org/b', clearToken: '1:cutoff' }, expect.any(AbortSignal));
  expect(f.container.querySelector('[data-notification-id="arrival"]')).not.toBeNull();
  expect(f.container.textContent).not.toContain('Could not clear notifications');
});

it('cancels pending clear when the scope changes and ignores a late success', async () => {
  let complete!: (value: ReturnType<typeof available<import('../sdk').CommunicationClearReceiptV1>>) => void;
  const pending = new Promise<ReturnType<typeof available<import('../sdk').CommunicationClearReceiptV1>>>(resolve => { complete = resolve; });
  const f = await setup({ ...notifications, clearToken: '1:cutoff' }, false, context => { context.services.communication!.clearNotifications = vi.fn(() => pending); });
  const service = f.context.services.communication!; click(f.container, '[data-slack-toggle]'); click(f.container, '[data-clear-notifications]');
  const signal = vi.mocked(service.clearNotifications!).mock.calls[0]![1]!;
  vi.mocked(service.notifications).mockResolvedValue(available({ ...notifications, clearToken: '2:cutoff', notifications: [{ ...item, repo: 'org/a' }] }));
  await f.instance.update({ ...f.state(), repo: 'org/a' }); await f.instance.refresh?.();
  expect(signal.aborted).toBe(true); complete(available({ version: 1, repo: 'org/b', clearToken: '1:cutoff', cleared: 1 })); await Promise.resolve();
  expect(f.container.querySelectorAll('.slack-notification')).toHaveLength(1);
  expect(f.container.textContent).toContain('org/a #42'); expect(f.container.textContent).not.toContain('Retry clear');
});

it('passes the inherited All scope when clearing the notifications page', async () => {
  const f = await fixture(panel, { repo: null, headerRepo: null, activity: { epoch: 1, repo: null, active: true, signal: new AbortController().signal } }, context => {
    vi.mocked(context.services.communication!.notifications).mockResolvedValue(available({ ...notifications, clearToken: '1:cutoff' }));
    context.services.communication!.clearNotifications = vi.fn(async input => available({ ...input, cleared: 1 }));
  });
  await f.instance.refresh?.(); click(f.container, '[data-clear-notifications]');
  expect(f.context.services.communication!.clearNotifications).toHaveBeenCalledWith({ version: 1, repo: null, clearToken: '1:cutoff' }, expect.any(AbortSignal));
});

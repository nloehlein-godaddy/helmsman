import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationCommandPendingV1, CommunicationCommandReceiptV1, CommunicationCommandServiceV1, CommunicationDestinationV1, CommunicationServiceV1, PluginPanelContext, PluginPanelState, PullRequestReadItemV1, PullRequestReadServiceV1 } from '@helmsman/plugin-sdk';
import { UnderwayReviews } from './reviews';

const repo = 'owner/project';
const target = { repo, number: 42, sourceRunId: 'run-one' };
const destination: CommunicationDestinationV1 = { providerId: 'helmsman.slack/slack', artifactHash: 'a'.repeat(64), workspace: 'team', channel: 'reviews', mention: 'reviewers', connectionId: 'connection' };
const input = { version: 1 as const, repo, number: 42, expectedDestination: destination };
const receipt: CommunicationCommandReceiptV1 = { version: 1, requestId: '11111111-1111-4111-8111-111111111111', input, status: 'succeeded', result: { repo, number: 42, destination, permalink: 'https://team.slack.com/archives/C123/p123456789' }, reason: null };
const pr: PullRequestReadItemV1 = { repo, number: 42, status: 'open', draft: false, title: 'Unrelated title', url: null, createdAt: '2026-09-30T00:00:00Z', mergedAt: null, ticketId: null, reviewDecision: null, comments: null, reviews: null };
function fixture() {
  const container = document.createElement('div'); document.body.append(container);
  const activity = new AbortController(); const lifetime = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel-one', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  let entries: readonly CommunicationCommandPendingV1[] = [];
  let renderedTarget = target;
  const settings = vi.fn<CommunicationServiceV1['settings']>(async () => ({ status: 'available', value: { version: 1, revision: 'r1', values: { enabled: true, watchEnabled: false, clientId: '', channelId: '', channelName: '', browserSurface: '', reviewChannel: 'reviews', reviewMention: 'reviewers' }, destination } }));
  const list = vi.fn<PullRequestReadServiceV1['list']>(async query => ({ status: 'available', value: { ...query, items: [pr], quality: 'complete', truncated: false, browseUrl: null } }));
  const pending = vi.fn<CommunicationCommandServiceV1['pending']>(async () => entries);
  const submit = vi.fn<CommunicationCommandServiceV1['submit']>(async submitted => { entries = [{ command: { ...submitted, requestId: receipt.requestId }, receipt }]; return { status: 'available', value: receipt }; });
  const retry = vi.fn<CommunicationCommandServiceV1['retry']>(async () => { entries = [{ command: { ...input, requestId: receipt.requestId }, receipt }]; return { status: 'available', value: receipt }; });
  const reconcile = vi.fn<CommunicationCommandServiceV1['receipt']>(async () => { entries = [{ command: { ...input, requestId: receipt.requestId }, receipt }]; return { status: 'available', value: receipt }; });
  const acknowledge = vi.fn<CommunicationCommandServiceV1['acknowledge']>(async query => { entries = entries.filter(entry => entry.command.requestId !== query.requestId); });
  const context: PluginPanelContext = { state, activity: state.activity, contributionId: 'helmsman.underway/panel', signal: lifetime.signal, services: { version: 1,
    communication: { version: 1, settings, notifications: vi.fn(), markRead: vi.fn(), saveSettings: vi.fn() },
    communicationCommands: { version: 1, submit, retry, receipt: reconcile, acknowledge, pending }, pullRequests: { version: 1, list, watchList: vi.fn() } }, saveState: vi.fn(), navigate: vi.fn(), onDispose: vi.fn() };
  const draw = () => { container.replaceChildren(); reviews.appendEvidence(container); reviews.appendAction(container, renderedTarget, 'review-action'); };
  const reviews = new UnderwayReviews(context, draw);
  const button = (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent === name);
  const refresh = async (next = state) => { await reviews.refresh(next); draw(); };
  return { container, state, activity, lifetime, context, reviews, refresh, draw, button, settings, list, pending, submit, retry, reconcile, acknowledge,
    get entries() { return entries; }, set entries(value: readonly CommunicationCommandPendingV1[]) { entries = value; }, set target(value: typeof target) { renderedTarget = value; } };
}
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });
describe('Underway contextual Slack reviews', () => {
  it('submits only after explicit click using the canonical PR and exact configured destination', async () => {
    const f = fixture(); await f.refresh();
    expect(f.list).toHaveBeenCalledWith({ version: 1, repo, kind: 'authored-recent', limit: 100 }, expect.any(AbortSignal));
    expect(f.submit).not.toHaveBeenCalled(); expect(f.button('Request review in Slack')?.disabled).toBe(false);
    f.button('Request review in Slack')!.click(); f.button('Request review in Slack')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Review requested in #reviews'));
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal)); expect(f.button('Request review in Slack')?.disabled).toBe(true);
    expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.container.querySelector('a')?.getAttribute('href')).toBe(receipt.result?.permalink);
  });
  it.each([{ ...pr, draft: true }, { ...pr, draft: null }, { ...pr, status: 'closed' as const }, { ...pr, status: 'merged' as const }, { ...pr, number: 99 }, { ...pr, repo: 'other/project' }])('does not send when authored PR evidence is ineligible: %j', async item => {
    const f = fixture(); f.list.mockImplementation(async query => ({ status: 'available', value: { ...query, items: [item], quality: 'complete', truncated: false, browseUrl: null } })); await f.refresh();
    expect(f.button('Request review in Slack')?.disabled).toBe(true); f.button('Request review in Slack')!.click(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('narrows all-galleon reads to the explicit source without changing the header scope', async () => {
    const f = fixture(); const state = { ...f.state, repo: null, headerRepo: null, activity: { ...f.state.activity, repo: null } };
    await f.reviews.refresh(state, repo); f.draw();
    expect(f.list).toHaveBeenCalledWith({ version: 1, repo, kind: 'authored-recent', limit: 100 }, expect.any(AbortSignal));
    expect(f.button('Request review in Slack')?.disabled).toBe(false); expect(f.context.navigate).not.toHaveBeenCalled();
  });
  it('blocks inconsistent explicit source selection outside a scoped host', async () => {
    const f = fixture(); await f.reviews.refresh(f.state, 'other/project'); f.draw();
    expect(f.list).not.toHaveBeenCalled(); expect(f.button('Request review in Slack')?.disabled).toBe(true);
  });
  it('does not infer PR identity from matching task text', async () => {
    const f = fixture(); f.target = { ...target, number: 9 }; await f.refresh(); expect(f.button('Request review in Slack')?.disabled).toBe(true);
  });
  it('fails closed for missing destination or unreadable journal without sending', async () => {
    const f = fixture(); f.settings.mockResolvedValue({ status: 'unavailable', reason: 'service-unavailable' }); await f.refresh(); expect(f.button('Request review in Slack')?.disabled).toBe(true);
    f.pending.mockRejectedValue(new Error('Storage blocked')); await f.refresh(); expect(f.container.textContent).toContain('Saved review requests are unavailable'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('retains unknown outcomes through remount and retries the original identity and destination', async () => {
    const f = fixture(); f.submit.mockImplementation(async () => { f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt: null }]; return { status: 'unavailable', reason: 'connection-failed' }; });
    await f.refresh(); f.button('Request review in Slack')!.click(); await vi.waitFor(() => expect(f.button('Retry original review request')?.disabled).toBe(false));
    const remounted = new UnderwayReviews(f.context, () => {}); await remounted.refresh(f.state); f.container.replaceChildren(); remounted.appendEvidence(f.container); remounted.appendAction(f.container, target, 'review');
    expect(f.button('Request review in Slack')?.disabled).toBe(true); f.button('Retry original review request')!.click();
    await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal))); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('checks saved receipts without sending again', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt: null }]; await f.refresh(); f.button('Check review receipt')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Review requested in #reviews')); expect(f.reconcile).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal)); expect(f.submit).not.toHaveBeenCalled();
  });
  it('preserves successful history before explicit repeat preparation and never sends on prepare', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt }]; await f.refresh(); f.button('Prepare another review request')!.click();
    await vi.waitFor(() => expect(f.button('Request review in Slack')?.disabled).toBe(false)); expect(f.acknowledge).toHaveBeenCalledTimes(1); expect(f.submit).not.toHaveBeenCalled(); expect(f.container.textContent).toContain('Review requested in #reviews');
    const remounted = new UnderwayReviews(f.context, () => {}); await remounted.refresh(f.state); f.container.replaceChildren(); remounted.appendAction(f.container, target, 'review');
    expect(f.button('Request review in Slack')?.disabled).toBe(true); expect(f.button('Prepare another review request')).toBeDefined();
  });
  it('archives terminal results even when their task is no longer displayed or eligible', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt }]; f.target = { ...target, number: 7 }; f.list.mockResolvedValue({ status: 'unavailable', reason: 'service-unavailable' }); await f.refresh();
    f.button('Archive review result')!.click(); await vi.waitFor(() => expect(f.acknowledge).toHaveBeenCalledOnce());
    expect(f.container.textContent).toContain('Review requested in #reviews'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('preserves original journal evidence if history cannot be saved', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt }]; await f.refresh(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); }); f.button('Prepare another review request')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Review history could not be saved')); expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('requires Recovery without offering delivery retry', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt: { ...receipt, status: 'recovery-required', result: null, reason: 'Delivery uncertain' } }]; await f.refresh();
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/recovery'); expect(f.button('Retry original review request')).toBeUndefined(); expect(f.button('Prepare another review request')).toBeUndefined(); expect(f.button('Request review in Slack')?.disabled).toBe(true);
  });
  it('aborts in-flight commands on scope change and ignores their late results', async () => {
    const f = fixture(); let complete!: (value: Awaited<ReturnType<CommunicationCommandServiceV1['submit']>>) => void;
    f.submit.mockImplementation(() => new Promise(resolve => { complete = resolve; })); await f.refresh(); f.button('Request review in Slack')!.click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    const signal = f.submit.mock.calls[0]?.[1]; const other = 'other/project'; const state = { ...f.state, repo: other, activity: { ...f.state.activity, repo: other, epoch: 2 } }; await f.refresh(state);
    expect(signal?.aborted).toBe(true); complete({ status: 'available', value: receipt }); await Promise.resolve(); await Promise.resolve();
    expect(f.container.textContent).not.toContain('Review request succeeded'); expect(f.container.textContent).not.toContain('Review requested in #reviews'); expect(f.button('Request review in Slack')?.disabled).toBe(true);
  });
  it('does not reuse delayed eligibility from a previous scope', async () => {
    const f = fixture(); let complete!: (value: Awaited<ReturnType<PullRequestReadServiceV1['list']>>) => void;
    f.list.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })); const old = f.refresh(); await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    await f.refresh({ ...f.state, repo: 'other/project', activity: { ...f.state.activity, repo: 'other/project', epoch: 2 } });
    complete({ status: 'available', value: { version: 1, repo, kind: 'authored-recent', items: [pr], quality: 'complete', truncated: false, browseUrl: null } }); await old;
    expect(f.button('Request review in Slack')?.disabled).toBe(true); expect(f.submit).not.toHaveBeenCalled();
  });
  it('rejects unsafe stored message URLs and malformed history', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: receipt.requestId }, receipt: { ...receipt, result: { ...receipt.result!, permalink: 'javascript:alert(1)' } } }]; await f.refresh(); expect(f.container.querySelector('a')).toBeNull();
    localStorage.setItem('helmsman.underway.reviews.v1:helmsman.underway/panel', '{bad json'); await f.refresh(); expect(f.container.textContent).toContain('Original data is kept'); expect(f.button('Request review in Slack')?.disabled).toBe(true);
  });
});

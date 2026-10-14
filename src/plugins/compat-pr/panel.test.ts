import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import panel from './panel';
import type { PluginPanelContext, PluginPanelInstance, PluginPanelState, PullRequestCommandInputV1, PullRequestCommandPendingV1, PullRequestCommandReceiptV1, PullRequestInspectDetailV1, PullRequestInspectDiffV1, RunReadPageV1, RunCommandPendingV1, RunCommandReceiptV1 } from '../sdk';

const head = 'a'.repeat(40); const base = 'b'.repeat(40);
const detail: PullRequestInspectDetailV1 = { version: 1, target: { repo: 'org/b', number: 42, headSha: head, baseSha: base }, observedAt: '2026-09-20T12:00:00Z', title: 'Public PR', url: 'https://github.com/org/b/pull/42', status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: '2026-09-20T12:00:00Z', comments: 3,
  checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 1, changesRequested: 0, commented: 2, requested: 0, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } };
const available = <T>(value: T) => ({ status: 'available' as const, value });
const requestId = 'b0ef36b8-e7a2-4b24-a343-2dac4b561824';
const lifetimes: AbortController[] = [];
beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/prs?repo=org/a'); });
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function fixture(overrides: Partial<PluginPanelState> = {}, configure?: (context: PluginPanelContext) => void, contributionId = 'helmsman.compat-pr/panel') {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime);
  let state: PluginPanelState = { repo: 'org/b', headerRepo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'pr', activity: { epoch: 1, signal: new AbortController().signal, active: true, repo: 'org/b' }, savedState: { version: 1, value: { target: { repo: 'org/b', number: 42 } } }, ...overrides };
  const reviewPending: PullRequestCommandPendingV1[] = []; const runPending: RunCommandPendingV1[] = [];
  const context: PluginPanelContext = { contributionId, state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), selectPresentation: vi.fn(), saveState: vi.fn(async () => {}),
    services: { version: 1,
      pullRequests: { version: 1, list: vi.fn(async query => available({ ...query, items: [], quality: 'complete', truncated: false, browseUrl: null })), watchList: vi.fn(() => vi.fn()) },
      pullRequestInspect: { version: 1, detail: vi.fn(async query => available({ ...detail, target: { ...detail.target, repo: query.repo, number: query.number } })), diff: vi.fn(async query => available<PullRequestInspectDiffV1>({ version: 1, target: query.target, observedAt: detail.observedAt, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [{ filename: 'src/file.ts', previousFilename: null, status: 'modified', additions: 1, deletions: 1, patch: '+new\n-old', patchStatus: 'preview' }] })) },
      runs: { version: 1, list: vi.fn(async query => available<RunReadPageV1>({ version: 1, repo: query.repo, items: [], nextCursor: null })), load: vi.fn(), log: vi.fn(), watchList: vi.fn(), watchLoad: vi.fn(), watchLog: vi.fn() },
      runCommands: { version: 1, submit: vi.fn(), retry: vi.fn(), receipt: vi.fn(), pending: vi.fn(async () => [...runPending]), acknowledge: vi.fn(async query => { const index = runPending.findIndex(item => item.command.requestId === query.requestId); if (index >= 0) runPending.splice(index, 1); }) },
      pullRequestCommands: { version: 1, submit: vi.fn(), retry: vi.fn(), receipt: vi.fn(), pending: vi.fn(async () => [...reviewPending]), acknowledge: vi.fn(async query => { const index = reviewPending.findIndex(item => item.command.requestId === query.requestId); if (index >= 0) reviewPending.splice(index, 1); }) },
    } };
  let instance: PluginPanelInstance;
  Object.assign(context, { setScope: vi.fn<NonNullable<PluginPanelContext['setScope']>>(async scope => { const repo = scope.kind === 'galleon' ? scope.repo : scope.kind === 'all' ? null : state.headerRepo ?? null; state = { ...state, repo, activity: { epoch: state.activity.epoch + 1, signal: new AbortController().signal, active: true, repo } }; await instance?.update(state); }) });
  configure?.(context); instance = await panel.mount(container, context);
  return { container, lifetime, context, instance, state: () => state, reviewPending, runPending };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) { await vi.waitFor(() => expect(f.container.querySelector<HTMLButtonElement>('.pr-comment')?.disabled).toBe(false)); }
function fill(container: HTMLElement, selector: string, value: string) { const control = container.querySelector<HTMLTextAreaElement>(selector)!; control.focus(); control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); }
function click(container: HTMLElement, selector: string) { container.querySelector<HTMLButtonElement>(selector)!.click(); }
const reviewReceipt = (input: PullRequestCommandInputV1, status: PullRequestCommandReceiptV1['status'] = 'succeeded'): PullRequestCommandReceiptV1 => ({ version: 1, requestId, input, status, result: status === 'succeeded' ? { repo: input.repo, number: input.number, headSha: input.expectedHeadSha, actor: 'authenticated-user', reviewId: 23 } : null, reason: status === 'succeeded' ? null : 'Original result uncertain' });

it('uses public list/detail/immutable diff services and preserves focused edits across refresh and reload', async () => {
  const f = await fixture(); await ready(f);
  expect(f.context.services.pullRequestInspect?.diff).toHaveBeenCalledWith({ version: 1, target: detail.target }, expect.any(AbortSignal));
  expect(f.container.textContent).toContain('complete file enumeration'); expect(f.container.textContent).toContain('2 passed');
  fill(f.container, '.pr-review-body', 'Retained draft'); const input = f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')!; input.setSelectionRange(2, 6);
  await f.instance.refresh?.(); expect(f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Retained draft'); expect(document.activeElement).toBe(f.container.querySelector('.pr-review-body')); expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(2);
  f.lifetime.abort(); const next = await fixture(); await ready(next); expect(next.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Retained draft');
  expect(next.context.navigate).not.toHaveBeenCalled(); expect(next.context.services.pullRequestCommands?.submit).not.toHaveBeenCalled();
});
it('keeps identical caller drafts shared between surfaces and copied caller drafts isolated', async () => {
  const original = await fixture(); await ready(original); fill(original.container, '.pr-review-body', 'Original draft');
  const second = await fixture(); await ready(second); expect(second.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Original draft');
  const copy = await fixture({}, undefined, 'example.copied-pr/panel'); await ready(copy); expect(copy.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('');
});
it('pins original review input through uncertain result, changed draft/head and explicit retry, then saves before acknowledgment', async () => {
  const f = await fixture(); await ready(f); const service = f.context.services.pullRequestCommands!;
  let input!: PullRequestCommandInputV1;
  vi.mocked(service.submit).mockImplementation(async next => { input = next; f.reviewPending.push({ command: { ...next, requestId }, receipt: null }); return { status: 'unavailable', reason: 'connection-failed' }; });
  fill(f.container, '.pr-review-body', 'Original review'); click(f.container, '.pr-comment'); await vi.waitFor(() => expect(f.container.textContent).toContain('Retry original request'));
  fill(f.container, '.pr-review-body', 'Newer unsent draft');
  vi.mocked(f.context.services.pullRequestInspect!.detail).mockResolvedValue(available({ ...detail, target: { ...detail.target, headSha: 'c'.repeat(40) } })); await f.instance.refresh?.();
  expect(service.submit).toHaveBeenCalledTimes(1); expect(service.retry).not.toHaveBeenCalled(); expect(f.container.querySelector<HTMLButtonElement>('.pr-comment')?.disabled).toBe(true);
  vi.mocked(service.retry).mockResolvedValue(available(reviewReceipt(input)));
  vi.mocked(service.acknowledge).mockImplementation(async () => { expect(Object.values(localStorage).some(value => value.includes('authenticated-user'))).toBe(true); f.reviewPending.splice(0); });
  click(f.container, '[data-retry="true"][data-pending-kind="review"]'); await vi.waitFor(() => expect(service.acknowledge).toHaveBeenCalled());
  expect(service.retry).toHaveBeenCalledWith({ repo: 'org/b', requestId }, expect.any(AbortSignal)); expect(input.expectedHeadSha).toBe(head); expect(input.body).toBe('Original review');
  expect(f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Newer unsent draft'); expect(f.container.textContent).toContain('Saved review result: succeeded by authenticated-user');
});
it('retains terminal receipt without acknowledgment when result storage fails', async () => {
  const f = await fixture(); await ready(f); const service = f.context.services.pullRequestCommands!;
  vi.mocked(service.submit).mockImplementation(async input => { const receipt = reviewReceipt(input); f.reviewPending.push({ command: { ...input, requestId }, receipt }); return available(receipt); });
  fill(f.container, '.pr-review-body', 'Save required'); const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) { if (key.includes(':result:')) throw new Error('Storage full'); original.call(this, key, value); });
  click(f.container, '.pr-comment'); await vi.waitFor(() => expect(f.container.textContent).toContain('Storage full')); expect(service.acknowledge).not.toHaveBeenCalled(); expect(f.reviewPending).toHaveLength(1);
});
it('preserves unsaved edits after failed draft storage and refresh and prevents submission', async () => {
  const f = await fixture(); await ready(f);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  fill(f.container, '.pr-review-body', 'Unstored current draft'); await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Unstored current draft'); expect(f.container.querySelector<HTMLButtonElement>('.pr-comment')?.disabled).toBe(true); expect(f.context.services.pullRequestCommands!.submit).not.toHaveBeenCalled();
});
it('launches review and rerun with durable public commands and opens shared scoped viewer after saved acceptance', async () => {
  const f = await fixture(); await ready(f); const service = f.context.services.runCommands!;
  vi.mocked(service.submit).mockImplementation(async input => { const receipt: RunCommandReceiptV1 = { version: 1, repo: input.repo, requestId, action: 'launch', status: 'accepted', runId: 'new-run', attempt: 1, message: null }; f.runPending.push({ command: { ...input, requestId }, receipt }); return available(receipt); });
  fill(f.container, '.pr-rerun-feedback', 'Change branch behavior'); click(f.container, '.pr-rerun');
  await vi.waitFor(() => expect(f.context.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/b', runId: 'new-run' }));
  expect(service.submit).toHaveBeenCalledWith({ version: 1, repo: 'org/b', action: 'launch', launch: { mode: 'rerun', prNumber: 42, feedback: 'Change branch behavior' } }, expect.any(AbortSignal)); expect(service.acknowledge).toHaveBeenCalled(); expect(f.state().headerRepo).toBe('org/a');
});
it.each(['review', 'rerun'] as const)('reveals route %s with explicit panel scope and no automatic command', async mode => {
  const f = await fixture({ activity: { epoch: 1, active: true, repo: 'org/a', signal: new AbortController().signal }, routeState: { version: 1, value: { target: { repo: 'org/b', number: 42 }, mode } } });
  await f.instance.refresh?.(); await ready(f);
  expect(f.context.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo: 'org/b' }); expect(f.state().headerRepo).toBe('org/a'); expect(document.activeElement).toBe(f.container.querySelector(mode === 'review' ? '.pr-review-agent' : '.pr-rerun-feedback'));
  expect(f.context.services.runCommands!.submit).not.toHaveBeenCalled();
});
it('lookup persists explicit target and panel scope while keeping header in route', async () => {
  const f = await fixture(); await ready(f); fill(f.container, '[data-pr-compat-lookup]', 'org/c#9'); click(f.container, '[data-load]');
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalled()); expect(f.context.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo: 'org/c' }); expect(f.context.saveState).toHaveBeenCalledWith({ version: 1, value: { target: { repo: 'org/c', number: 9 } } });
  const url = new URL(vi.mocked(f.context.navigate).mock.calls[0]![0], 'https://host.test'); expect(url.searchParams.get('repo')).toBe('org/a'); expect(url.searchParams.get('prRepo')).toBe('org/c'); expect(url.searchParams.get('panel')).toBe('pr');
});
it('fails commands closed after journal read failure and does not overwrite unsupported stored drafts', async () => {
  localStorage.setItem('helmsman.pull-request.v1:helmsman.compat-pr/panel:draft:["org/b",42]', '{"version":9,"future":true}');
  const f = await fixture({}, context => { vi.mocked(context.services.pullRequestCommands!.pending).mockRejectedValue(new Error('Unavailable')); });
  await vi.waitFor(() => expect(f.container.textContent).toContain('Command journal unavailable'));
  expect(f.container.querySelector<HTMLButtonElement>('.pr-comment')?.disabled).toBe(true); expect(localStorage.getItem('helmsman.pull-request.v1:helmsman.compat-pr/panel:draft:["org/b",42]')).toBe('{"version":9,"future":true}');
});
it('hides cancel public reads and ignores late responses', async () => {
  let resolve!: (value: ReturnType<typeof available<PullRequestInspectDetailV1>>) => void; const pending = new Promise<ReturnType<typeof available<PullRequestInspectDetailV1>>>(done => { resolve = done; });
  const f = await fixture({}, context => { vi.mocked(context.services.pullRequestInspect!.detail).mockReturnValue(pending); });
  const signal = vi.mocked(f.context.services.pullRequestInspect!.detail).mock.calls[0]?.[1]; await f.instance.update({ ...f.state(), visible: false }); expect(signal?.aborted).toBe(true);
  resolve(available(detail)); await Promise.resolve(); expect(f.container.querySelector('.pr-panel')).toBeNull(); expect(f.context.services.pullRequestInspect!.diff).not.toHaveBeenCalled();
});
it('renders unknown counts and patch truncation without inventing completeness', async () => {
  const f = await fixture({}, context => {
    vi.mocked(context.services.pullRequestInspect!.detail).mockResolvedValue(available({ ...detail, checks: { quality: 'partial', passed: null, failed: null, pending: null }, reviews: { ...detail.reviews, quality: 'unavailable', approved: null, changesRequested: null, commented: null, requested: null } }));
    vi.mocked(context.services.pullRequestInspect!.diff).mockResolvedValue(available({ version: 1, target: detail.target, observedAt: detail.observedAt, coverage: 'immutable-comparison-preview', quality: 'partial', truncated: true, files: [{ filename: 'large.bin', previousFilename: null, status: 'modified', additions: 0, deletions: 0, patch: null, patchStatus: 'unavailable' }] }));
  }); await ready(f); expect(f.container.textContent).toContain('Unknown passed'); expect(f.container.textContent).toContain('partial file enumeration'); expect(f.container.textContent).toContain('Inline patch unavailable');
});
it.each(['../private', 'org/..', '-owner/repo', 'org/repo?bad', 'org/repo/extra', 'org/' + 'x'.repeat(101)])('rejects malformed route target before inspection: %s', async repo => {
  const f = await fixture({ savedState: null, routeState: { version: 1, value: { target: { repo, number: 1 }, mode: 'review' } } }); await f.instance.refresh?.(); expect(f.context.services.pullRequestInspect!.detail).not.toHaveBeenCalled();
});
it('rejects missing mounted contribution identity before storage access', async () => {
  const read = vi.spyOn(Storage.prototype, 'getItem'); await expect(fixture({}, context => { delete (context as { contributionId?: string }).contributionId; })).rejects.toThrow('mounted contribution identity'); expect(read).not.toHaveBeenCalled();
});
it('uses public PR route hint for renamed panel copies while a run presentation is also selected', async () => {
  const f = await fixture({ savedState: null, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'selected-run' }, pullRequest: { version: 1, repo: 'org/b', number: 42, mode: 'rerun' } }, undefined, 'example.copied-pr/panel'); await ready(f);
  expect(f.container.querySelector<HTMLElement>('.pr-panel')?.dataset.prRepo).toBe('org/b'); expect(document.activeElement).toBe(f.container.querySelector('.pr-rerun-feedback')); expect(f.context.services.runCommands!.submit).not.toHaveBeenCalled();
});
it('does not restore the previous explicit target while lookup changes scope', async () => {
  const f = await fixture({ pullRequest: { version: 1, repo: 'org/b', number: 42, mode: null } }); await ready(f);
  fill(f.container, '[data-pr-compat-lookup]', 'org/c#9'); click(f.container, '[data-load]'); await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalled());
  expect(f.state().activity.repo).toBe('org/c'); expect(vi.mocked(f.context.setScope!).mock.calls).toEqual([[{ kind: 'galleon', repo: 'org/c' }]]);
});
it('closes inspection, clears its route and restores inherited scope while keeping drafts', async () => {
  const route = new URLSearchParams({ repo: 'org/a', prRepo: 'org/b', pr: '42', mode: 'review', pane: 'diff', panelState: JSON.stringify({ 'helmsman.compat-pr/panel': { version: 1, value: { target: { repo: 'org/b', number: 42 } } }, other: { version: 1, value: {} } }) });
  history.replaceState(null, '', `/prs?${route}`);
  const f = await fixture({ pullRequest: { version: 1, repo: 'org/b', number: 42, mode: null } }); await ready(f);
  fill(f.container, '.pr-review-body', 'Keep the review draft'); click(f.container, '[data-close-inspection]');
  await vi.waitFor(() => { expect(f.context.setScope).toHaveBeenCalledWith({ kind: 'inherit' }); expect(f.container.querySelector('[data-close-inspection]')).toBeNull(); expect(f.container.querySelector<HTMLButtonElement>('[data-load]')?.disabled).toBe(false); });
  expect(f.state().activity.repo).toBe('org/a'); expect(f.container.querySelector('.pr-panel')).toBeNull(); expect(f.container.querySelector('[data-close-inspection]')).toBeNull();
  const navigated = new URL(vi.mocked(f.context.navigate).mock.calls.at(-1)![0], window.location.origin);
  for (const key of ['pr', 'prRepo', 'mode', 'pane']) expect(navigated.searchParams.has(key)).toBe(false);
  expect(JSON.parse(navigated.searchParams.get('panelState')!)).toEqual({ other: { version: 1, value: {} } });
  fill(f.container, '[data-pr-compat-lookup]', 'org/b#42'); click(f.container, '[data-load]'); await ready(f);
  expect(f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Keep the review draft');
});
it.each(['setScope', 'navigate', 'saveState'] as const)('keeps Close inspection retryable when %s fails', async operation => {
  const f = await fixture(); await ready(f);
  if (operation === 'navigate') vi.mocked(f.context.navigate).mockImplementationOnce(() => { throw new Error('Temporary failure'); });
  else vi.mocked(f.context[operation]!).mockRejectedValueOnce(new Error('Temporary failure'));
  click(f.container, '[data-close-inspection]');
  await vi.waitFor(() => expect(f.container.textContent).toContain('Choose Close inspection to try again.'));
  expect(f.container.querySelector<HTMLButtonElement>('[data-close-inspection]')?.disabled).toBe(false);
  expect(document.activeElement).toBe(f.container.querySelector('[data-close-inspection]'));
  expect(f.container.querySelector('.pr-panel')).toBeNull();
  click(f.container, '[data-close-inspection]');
  await vi.waitFor(() => expect(f.container.querySelector('[data-close-inspection]')).toBeNull());
  expect(f.state().activity.repo).toBe('org/a');
  expect(f.context.saveState).toHaveBeenCalledWith({ version: 1, value: { target: null } });
  expect(f.container.querySelector<HTMLInputElement>('[data-pr-compat-lookup]')?.value).toBe('');
});
it('closes inspection in an older standalone host without scope mutation support', async () => {
  const f = await fixture({}, context => { delete (context as { setScope?: PluginPanelContext['setScope'] }).setScope; }); await ready(f); click(f.container, '[data-close-inspection]');
  await vi.waitFor(() => expect(f.context.saveState).toHaveBeenCalledWith({ version: 1, value: { target: null } }));
  expect(f.container.querySelector('.pr-panel')).toBeNull(); expect(f.container.querySelector<HTMLInputElement>('[data-pr-compat-lookup]')?.value).toBe('');
});
it('keeps run history disclosure state and summary focus across refresh', async () => {
  const f = await fixture(); await ready(f);
  const history = f.container.querySelector<HTMLDetailsElement>('[data-pr-disclosure="recent-runs"]')!; expect(history.open).toBe(false); history.open = true;
  history.querySelector<HTMLElement>('summary')!.focus(); await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLDetailsElement>('[data-pr-disclosure="recent-runs"]')?.open).toBe(true);
  expect(document.activeElement).toBe(f.container.querySelector('[data-pr-disclosure="recent-runs"]>summary'));
});
it('focuses pane-only navigation without issuing commands', async () => {
  const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const f = await fixture({ savedState: null }); await f.instance.refresh?.(); await f.instance.update({ ...f.state(), pane: 'authored' }); expect(scroll).toHaveBeenCalled(); expect(f.context.services.pullRequestCommands!.submit).not.toHaveBeenCalled();
});
it('rehydrates a retained request after remount and only checks it on explicit action', async () => {
  const input: PullRequestCommandInputV1 = { version: 1, repo: 'org/b', number: 42, expectedHeadSha: head, event: 'COMMENT', body: 'Retained original' };
  const f = await fixture({}, context => { vi.mocked(context.services.pullRequestCommands!.pending).mockResolvedValue([{ command: { ...input, requestId }, receipt: null }]); });
  await vi.waitFor(() => expect(f.container.textContent).toContain('Retained original')); expect(f.context.services.pullRequestCommands!.receipt).not.toHaveBeenCalled(); expect(f.context.services.pullRequestCommands!.retry).not.toHaveBeenCalled(); expect(f.container.querySelector<HTMLButtonElement>('.pr-comment')?.disabled).toBe(true);
  vi.mocked(f.context.services.pullRequestCommands!.receipt).mockResolvedValue(available(null)); click(f.container, '[data-pending-id]:not([data-retry])');
  await vi.waitFor(() => expect(f.context.services.pullRequestCommands!.receipt).toHaveBeenCalledWith({ repo: 'org/b', requestId }, expect.any(AbortSignal))); expect(f.context.services.pullRequestCommands!.submit).not.toHaveBeenCalled();
});
it('keeps opaque panel state with unknown fields unchanged during explicit lookup', async () => {
  const f = await fixture({ savedState: { version: 1, value: { target: { repo: 'org/b', number: 42 }, future: true } } }); await f.instance.refresh?.();
  fill(f.container, '[data-pr-compat-lookup]', 'org/b#42'); click(f.container, '[data-load]'); await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalled()); expect(f.context.saveState).not.toHaveBeenCalled(); expect(f.container.textContent).toContain('unsupported format');
});
const connection = (status: 'connected' | 'disconnected' | 'error' | 'unsupported' | 'setup-required') => available({ version: 1 as const, providerId: 'test.communication', revision: '1', status, message: '', accountLabel: null, redirectUri: null });
it('shows connected Slack action with the header scope and explicit PR target, without duplicate setup links', async () => {
  const status = vi.fn(async () => connection('connected'));
  const f = await fixture({ repo: 'org/b', headerRepo: 'org/a' }, context => { Object.assign(context.services, { communication: { version: 1, connectionStatus: status, notifications: vi.fn(), markRead: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() } satisfies NonNullable<PluginPanelContext['services']['communication']> }); }); await ready(f);
  const link = f.container.querySelector<HTMLAnchorElement>('.pr-slack-review')!;
  expect(new URL(link.href).searchParams.get('repo')).toBe('org/a'); expect(new URL(link.href).searchParams.get('prRepo')).toBe('org/b'); expect(new URL(link.href).searchParams.get('pr')).toBe('42');
  expect(f.container.textContent).not.toContain('Open review setup'); expect(f.container.textContent).not.toContain('Open branch update setup'); expect(f.container.textContent).not.toContain('signed-in GitHub account');
  expect(status).toHaveBeenCalledWith(expect.any(AbortSignal)); expect(f.context.services.runCommands!.submit).not.toHaveBeenCalled();
  await f.instance.update({ ...f.state(), headerRepo: null }); expect(new URL(f.container.querySelector<HTMLAnchorElement>('.pr-slack-review')!.href).searchParams.has('repo')).toBe(false);
  status.mockResolvedValue(connection('disconnected')); await f.instance.refresh?.(); expect(f.container.querySelector('.pr-slack-review')).toBeNull();
});
it.each(['disconnected', 'error', 'unsupported', 'setup-required'] as const)('hides Slack when connection is %s', async status => {
  const f = await fixture({}, context => { Object.assign(context.services, { communication: { version: 1, connectionStatus: vi.fn(async () => connection(status)), notifications: vi.fn(), markRead: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() } satisfies NonNullable<PluginPanelContext['services']['communication']> }); }); await ready(f); expect(f.container.querySelector('.pr-slack-review')).toBeNull();
});
it('keeps PR controls usable when the optional connection read fails', async () => {
  const f = await fixture({}, context => { Object.assign(context.services, { communication: { version: 1, connectionStatus: vi.fn(async () => { throw new Error('offline'); }), notifications: vi.fn(), markRead: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() } satisfies NonNullable<PluginPanelContext['services']['communication']> }); }); await ready(f); expect(f.container.querySelector('.pr-slack-review')).toBeNull(); expect(f.container.querySelector<HTMLButtonElement>('.pr-review-agent')?.disabled).toBe(false);
});
it('does not block inspection or agent actions while the connection read is pending', async () => {
  const f = await fixture({}, context => { Object.assign(context.services, { communication: { version: 1, connectionStatus: vi.fn(() => new Promise(() => {})), notifications: vi.fn(), markRead: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() } }); });
  await ready(f); expect(f.container.querySelector('.pr-panel-title')?.textContent).toBe('Public PR'); expect(f.container.querySelector<HTMLButtonElement>('.pr-review-agent')?.disabled).toBe(false); expect(f.container.querySelector('.pr-slack-review')).toBeNull();
});
it('ignores a stale connected result after hiding and a disconnected refresh', async () => {
  let resolve!: (value: ReturnType<typeof connection>) => void;
  const pending = new Promise<ReturnType<typeof connection>>(done => { resolve = done; });
  const status = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(connection('disconnected'));
  const f = await fixture({}, context => { Object.assign(context.services, { communication: { version: 1, connectionStatus: status, notifications: vi.fn(), markRead: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() } satisfies NonNullable<PluginPanelContext['services']['communication']> }); });
  const signal = status.mock.calls[0]?.[0] as AbortSignal; await f.instance.update({ ...f.state(), visible: false }); expect(signal.aborted).toBe(true);
  await f.instance.update({ ...f.state(), visible: true }); await ready(f); resolve(connection('connected')); await Promise.resolve(); await Promise.resolve(); expect(f.container.querySelector('.pr-slack-review')).toBeNull();
});
it('preserves a legacy saved explicit target when its old layout still inherits a different header', async () => {
  const f = await fixture({ repo: 'org/a', headerRepo: 'org/a', activity: { epoch: 1, active: true, repo: 'org/a', signal: new AbortController().signal } }); await f.instance.refresh?.(); await ready(f);
  expect(f.context.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo: 'org/b' }); expect(f.state().headerRepo).toBe('org/a'); expect(f.container.querySelector<HTMLElement>('.pr-panel')?.dataset.prRepo).toBe('org/b'); expect(f.context.services.pullRequestCommands!.submit).not.toHaveBeenCalled();
});
it('does not replace the next field during a blur/change storage notification and retains that edit across surfaces', async () => {
  const f = await fixture(); await ready(f); fill(f.container, '.pr-review-body', 'Review before moving focus');
  const body = f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')!; const feedback = f.container.querySelector<HTMLTextAreaElement>('.pr-rerun-feedback')!;
  body.blur(); body.dispatchEvent(new Event('change', { bubbles: true }));
  expect(feedback.isConnected).toBe(true); feedback.focus(); feedback.value = 'Feedback entered while moving focus'; feedback.dispatchEvent(new Event('input', { bubbles: true })); feedback.blur(); feedback.dispatchEvent(new Event('change', { bubbles: true }));
  f.lifetime.abort(); const next = await fixture(); await ready(next);
  expect(next.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Review before moving focus'); expect(next.container.querySelector<HTMLTextAreaElement>('.pr-rerun-feedback')?.value).toBe('Feedback entered while moving focus');
});

it.each(['10254', '#10254', '  #10254  '])('resolves bare lookup %s against header scope after a panel override', async input => {
  const f = await fixture(); await ready(f);
  fill(f.container, '[data-pr-compat-lookup]', input); click(f.container, '[data-load]');
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalled());
  expect(f.context.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo: 'org/a' });
  expect(f.context.saveState).toHaveBeenCalledWith({ version: 1, value: { target: { repo: 'org/a', number: 10254 } } });
  const url = new URL(vi.mocked(f.context.navigate).mock.calls[0]![0], 'https://host.test');
  expect(url.searchParams.get('repo')).toBe('org/a'); expect(url.searchParams.get('prRepo')).toBe('org/a');
});
it.each(['12', '#12'])('rejects bare lookup %s when header scope is all repositories', async input => {
  const f = await fixture({ headerRepo: null }); await ready(f);
  vi.mocked(f.context.services.pullRequestInspect!.detail).mockClear();
  fill(f.container, '[data-pr-compat-lookup]', input); click(f.container, '[data-load]');
  expect(f.container.textContent).toContain('Select a repository'); expect(f.container.textContent).toContain('full GitHub URL');
  expect(f.context.navigate).not.toHaveBeenCalled(); expect(f.context.services.pullRequestInspect!.detail).not.toHaveBeenCalled();
});
it('leaves external links independent from PR selection', async () => {
  const f = await fixture(); await ready(f);
  const link = f.container.querySelector<HTMLAnchorElement>('.pr-panel a[target="_blank"]')!;
  const click = new MouseEvent('click', { bubbles: true, cancelable: true }); link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false); expect(f.context.navigate).not.toHaveBeenCalled(); expect(f.context.setScope).not.toHaveBeenCalled();
});

it.each([{ isComposing: true }, { repeat: true }])('ignores Enter during composition or repeat: %j', async init => {
  const f = await fixture(); await ready(f); fill(f.container, '[data-pr-compat-lookup]', 'org/c#9');
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  f.container.querySelector('[data-pr-compat-lookup]')!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false); expect(f.context.navigate).not.toHaveBeenCalled();
  f.container.querySelector('[data-pr-compat-lookup]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalled());
  expect(f.context.navigate).toHaveBeenCalledTimes(1);
});


it('explains the pinned PR comparison in Whiteboard and preserves the header scope', async () => {
  const pinned = { kind: 'pull-request' as const, ...detail.target };
  const snapshot = { version: 1 as const, target: pinned, status: 'absent' as const, sessionId: null, baseSha: base, headSha: head, message: null };
  const whiteboard = { version: 1 as const, read: vi.fn(async () => available(snapshot)), explain: vi.fn(async () => available({ ...snapshot, status: 'ready' as const, sessionId: 'session' })), open: vi.fn(async () => available({ ...snapshot, status: 'ready' as const, sessionId: 'session' })) };
  const f = await fixture({}, context => { Object.assign(context.services, { whiteboard }); }); await ready(f);
  const action = () => f.container.querySelector<HTMLButtonElement>('.whiteboard-companion button')!;
  await vi.waitFor(() => expect(action().disabled).toBe(false)); action().click();
  await vi.waitFor(() => expect(action().textContent).toBe('Open in Whiteboard'));
  expect(whiteboard.explain).toHaveBeenCalledWith(pinned, expect.any(AbortSignal));
  action().focus(); await f.instance.refresh?.(); expect(document.activeElement).toBe(action());
  action().click(); await vi.waitFor(() => expect(whiteboard.open).toHaveBeenCalledWith(pinned, expect.any(AbortSignal)));
  expect(f.state().headerRepo).toBe('org/a'); expect(f.context.navigate).not.toHaveBeenCalled();
});

it.each(['authored-list', 'review-requests-list'])('retains both closed and reopened %s choices and summary focus through refresh without issuing commands', async key => {
  const f = await fixture(); await ready(f);
  const selector = `[data-pr-disclosure="${key}"]`; const section = f.container.querySelector<HTMLDetailsElement>(selector)!; expect(section.open).toBe(true);
  section.open = false; section.querySelector<HTMLElement>('summary')!.focus(); await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLDetailsElement>(selector)?.open).toBe(false); expect(document.activeElement).toBe(f.container.querySelector(`${selector}>summary`));
  f.container.querySelector<HTMLDetailsElement>(selector)!.open = true; await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLDetailsElement>(selector)?.open).toBe(true); expect(document.activeElement).toBe(f.container.querySelector(`${selector}>summary`));
  expect(f.container.querySelector<HTMLDetailsElement>('[data-pr-disclosure="recent-runs"]')?.open).toBe(false);
  expect(f.context.services.pullRequestCommands?.submit).not.toHaveBeenCalled(); expect(f.context.services.runCommands?.submit).not.toHaveBeenCalled();
});

it('preserves context and manual review disclosure choices and summary focus through refresh', async () => {
  const f = await fixture(); await ready(f);
  const manual = f.container.querySelector<HTMLDetailsElement>('.pr-manual-review')!;
  const context = f.container.querySelector<HTMLDetailsElement>('.pr-provenance')!;
  expect(manual.open).toBe(false); expect(context.open).toBe(false);
  manual.open = true; context.open = true; manual.querySelector('summary')!.focus();
  await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLDetailsElement>('.pr-manual-review')?.open).toBe(true); expect(f.container.querySelector<HTMLDetailsElement>('.pr-provenance')?.open).toBe(true);
  expect(document.activeElement).toBe(f.container.querySelector('.pr-manual-review>summary'));
  fill(f.container, '.pr-review-body', 'Saved review'); f.container.querySelector<HTMLDetailsElement>('.pr-manual-review')!.open = false;
  await f.instance.refresh?.(); expect(f.container.querySelector<HTMLDetailsElement>('.pr-manual-review')?.open).toBe(false);
  f.lifetime.abort(); const next = await fixture(); await ready(next); expect(next.container.querySelector<HTMLDetailsElement>('.pr-manual-review')?.open).toBe(true);
});

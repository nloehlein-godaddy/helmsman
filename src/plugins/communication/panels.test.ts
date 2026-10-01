import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from './review-request';
import settings from './settings';
import { available, click, fill, fixture, lifetimes, requestId, snapshot, terminal } from './fixtures.test-support';
import type { CommunicationCommandInputV1 } from '../sdk';
beforeEach(() => { localStorage.clear(); });
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); vi.restoreAllMocks(); document.body.replaceChildren(); });
const ready = async (f: Awaited<ReturnType<typeof fixture>>, selector = '[data-send-review]') => { await vi.waitFor(() => expect(f.container.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(false)); };
const settingsFixture = () => fixture(settings, {}, undefined, 'helmsman.communication/settings');
it('shows the pinned destination without automatically sending, retrying, checking or acknowledging', async () => {
  const f = await fixture(request); await ready(f); await f.instance.refresh?.(); expect(f.container.textContent).toContain('workspace · #reviews · @team'); const service = f.context.services.communicationCommands!;
  for (const fn of [service.submit, service.retry, service.receipt, service.acknowledge]) expect(fn).not.toHaveBeenCalled();
});
it('preserves edited lookup after reload and isolates copied contribution storage', async () => {
  const f = await fixture(request, { pullRequest: undefined }); await f.instance.refresh?.(); fill(f.container, '[data-review-lookup]', 'org/b#42'); click(f.container, '[data-select-pr]'); await ready(f); fill(f.container, '[data-review-lookup]', 'org/c#unfinished'); f.lifetime.abort();
  const next = await fixture(request, { pullRequest: undefined }); await ready(next); expect(next.container.querySelector<HTMLInputElement>('[data-review-lookup]')?.value).toBe('org/c#unfinished');
  const copy = await fixture(request, { pullRequest: undefined }, undefined, 'example.communication/request'); await copy.instance.refresh?.(); expect(copy.container.querySelector<HTMLInputElement>('[data-review-lookup]')?.value).toBe('');
});
it('pins original target and destination through settings change and explicit retry, saving before acknowledgment', async () => {
  const f = await fixture(request); await ready(f); const service = f.context.services.communicationCommands!; let input!: CommunicationCommandInputV1;
  vi.mocked(service.submit).mockImplementation(async next => { input = next; f.pending.push({ command: { ...next, requestId }, receipt: null }); return { status: 'unavailable', reason: 'connection-failed' }; });
  click(f.container, '[data-send-review]'); await vi.waitFor(() => expect(f.container.textContent).toContain('Retry original request'));
  vi.mocked(f.context.services.communication!.settings).mockResolvedValue(available({ ...snapshot, destination: { ...snapshot.destination!, channel: 'different' } })); await f.instance.refresh?.(); fill(f.container, '[data-review-lookup]', 'org/c#new-draft');
  vi.mocked(service.retry).mockResolvedValue(available(terminal(input))); vi.mocked(service.acknowledge).mockImplementation(async () => { expect(Object.values(localStorage).some(raw => raw.includes('"status":"succeeded"'))).toBe(true); f.pending.splice(0); });
  click(f.container, '[data-retry="true"]'); await vi.waitFor(() => expect(service.acknowledge).toHaveBeenCalled()); expect(service.retry).toHaveBeenCalledWith({ repo: 'org/b', requestId }, expect.any(AbortSignal)); expect(input.expectedDestination.channel).toBe('reviews'); expect(f.container.querySelector<HTMLInputElement>('[data-review-lookup]')?.value).toBe('org/c#new-draft'); expect(service.submit).toHaveBeenCalledTimes(1);
});
it('keeps terminal journal evidence when local result storage fails', async () => {
  const f = await fixture(request); await ready(f); const service = f.context.services.communicationCommands!; vi.mocked(service.submit).mockImplementation(async input => { const receipt = terminal(input); f.pending.push({ command: { ...input, requestId }, receipt }); return available(receipt); });
  const original = Storage.prototype.setItem; vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) { if (key.includes(':result:')) throw new Error('Storage full'); original.call(this, key, value); });
  click(f.container, '[data-send-review]'); await vi.waitFor(() => expect(f.container.textContent).toContain('Storage full')); expect(service.acknowledge).not.toHaveBeenCalled(); expect(f.pending).toHaveLength(1);
});
it('reconciles retained original receipt only on explicit action after remount', async () => {
  const input: CommunicationCommandInputV1 = { version: 1, repo: 'org/b', number: 42, expectedDestination: snapshot.destination! };
  const f = await fixture(request, {}, context => { vi.mocked(context.services.communicationCommands!.pending).mockResolvedValue([{ command: { ...input, requestId }, receipt: null }]); }); await vi.waitFor(() => expect(f.container.textContent).toContain('Retry original request')); const service = f.context.services.communicationCommands!; expect(service.receipt).not.toHaveBeenCalled(); expect(service.retry).not.toHaveBeenCalled(); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true);
  vi.mocked(service.receipt).mockResolvedValue(available(null)); click(f.container, '[data-request-id]:not([data-retry])'); await vi.waitFor(() => expect(service.receipt).toHaveBeenCalledWith({ repo: 'org/b', requestId }, expect.any(AbortSignal))); expect(service.submit).not.toHaveBeenCalled();
});
it('uses explicit target scope without changing the header or restoring old route during lookup', async () => {
  const f = await fixture(request, { repo: 'org/a', activity: { epoch: 1, signal: new AbortController().signal, active: true, repo: 'org/a' } }); await f.instance.refresh?.(); await ready(f); expect(f.context.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo: 'org/b' });
  fill(f.container, '[data-review-lookup]', 'org/c#9'); click(f.container, '[data-select-pr]'); await vi.waitFor(() => expect(f.state().activity.repo).toBe('org/c')); expect(f.state().headerRepo).toBe('org/a'); expect(f.container.textContent).toContain('org/c #9'); expect(f.context.services.communicationCommands!.submit).not.toHaveBeenCalled();
});
it('blocks new sends on unknown stored drafts or failed journal reads and keeps original bytes', async () => {
  const key = 'helmsman.communication.v1:helmsman.communication/review-request:review-target'; localStorage.setItem(key, '{"version":9,"future":true}');
  const f = await fixture(request, {}, context => { vi.mocked(context.services.communicationCommands!.pending).mockRejectedValue(new Error('offline')); }); await f.instance.refresh?.(); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true); expect(localStorage.getItem(key)).toBe('{"version":9,"future":true}'); expect(f.context.services.communicationCommands!.submit).not.toHaveBeenCalled();
});
it('preserves settings edits, selection and original revision across refresh and remount', async () => {
  const f = await settingsFixture(); await ready(f, '[data-save-settings]'); fill(f.container, '[data-setting="reviewChannel"]', 'my-draft'); f.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')!.setSelectionRange(2, 5);
  vi.mocked(f.context.services.communication!.settings).mockResolvedValue(available({ ...snapshot, revision: 'revision-new', values: { ...snapshot.values, reviewChannel: 'server-value' } })); await f.instance.refresh?.(); expect(f.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')?.value).toBe('my-draft'); expect((document.activeElement as HTMLInputElement).selectionStart).toBe(2); expect(f.container.textContent).toContain('original revision');
  f.lifetime.abort(); const next = await settingsFixture(); await ready(next, '[data-save-settings]'); expect(next.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')?.value).toBe('my-draft'); click(next.container, '[data-save-settings]'); await vi.waitFor(() => expect(next.context.services.communication!.saveSettings).toHaveBeenCalledWith({ expectedRevision: 'revision-1', values: { ...snapshot.values, reviewChannel: 'my-draft' } }, expect.any(AbortSignal))); expect(next.context.services.communicationCommands!.submit).not.toHaveBeenCalled();
});
it('retains both consecutive settings edits without detaching the next input during blur', async () => {
  const f = await settingsFixture(); await ready(f, '[data-save-settings]'); fill(f.container, '[data-setting="reviewChannel"]', 'first'); const first = f.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')!; const next = f.container.querySelector<HTMLInputElement>('[data-setting="reviewMention"]')!;
  first.dispatchEvent(new Event('change', { bubbles: true })); expect(next.isConnected).toBe(true); fill(f.container, '[data-setting="reviewMention"]', 'second'); f.lifetime.abort(); const restored = await settingsFixture(); await ready(restored, '[data-save-settings]'); expect(restored.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')?.value).toBe('first'); expect(restored.container.querySelector<HTMLInputElement>('[data-setting="reviewMention"]')?.value).toBe('second');
});
it('retains settings edits on revision conflict and saves settings without commands', async () => {
  const f = await settingsFixture(); await ready(f, '[data-save-settings]'); fill(f.container, '[data-setting="reviewChannel"]', 'draft-channel'); vi.mocked(f.context.services.communication!.saveSettings).mockResolvedValueOnce({ status: 'unavailable', reason: 'conflict' }); click(f.container, '[data-save-settings]'); await vi.waitFor(() => expect(f.container.textContent).toContain('conflict')); expect(f.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')?.value).toBe('draft-channel');
  click(f.container, '[data-save-settings]'); await vi.waitFor(() => expect(f.container.textContent).toContain('Settings saved. No message was sent.')); expect(f.context.services.communicationCommands!.submit).not.toHaveBeenCalled(); expect(f.context.services.communicationCommands!.retry).not.toHaveBeenCalled();
});
it('retains in-memory settings when draft storage fails and blocks save until persistence succeeds', async () => {
  const f = await settingsFixture(); await ready(f, '[data-save-settings]'); const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); }); fill(f.container, '[data-setting="reviewChannel"]', 'memory-draft'); await f.instance.refresh?.(); expect(f.container.querySelector<HTMLInputElement>('[data-setting="reviewChannel"]')?.value).toBe('memory-draft'); expect(f.container.querySelector<HTMLButtonElement>('[data-save-settings]')?.disabled).toBe(true); spy.mockRestore(); click(f.container, '[data-save-draft]'); expect(f.container.querySelector<HTMLButtonElement>('[data-save-settings]')?.disabled).toBe(false);
});
it('preserves unknown settings drafts without saving or overwriting them', async () => {
  const key = 'helmsman.communication.v1:helmsman.communication/settings:settings-draft'; localStorage.setItem(key, '{"version":9,"future":true}'); const f = await settingsFixture(); await f.instance.refresh?.(); expect(f.container.querySelector<HTMLButtonElement>('[data-save-settings]')?.disabled).toBe(true); click(f.container, '[data-reload-settings]'); expect(localStorage.getItem(key)).toBe('{"version":9,"future":true}'); expect(f.context.services.communication!.saveSettings).not.toHaveBeenCalled();
});
it('does not admit a send after panel hiding while the journal preflight is unresolved', async () => {
  const f = await fixture(request); await ready(f); const service = f.context.services.communicationCommands!; let resolve!: (value: []) => void; vi.mocked(service.pending).mockReturnValueOnce(new Promise<[]>(done => { resolve = done; })); click(f.container, '[data-send-review]'); await f.instance.update({ ...f.state(), visible: false }); resolve([]); await vi.waitFor(() => expect(f.container.textContent).toContain('canceled before submission')); expect(service.submit).not.toHaveBeenCalled();
});
it('keeps unsupported saved result evidence blocking new sends after editing a draft', async () => {
  const key = 'helmsman.communication.v1:helmsman.communication/review-request:result:unknown'; localStorage.setItem(key, '{"version":9}'); const f = await fixture(request); await f.instance.refresh?.(); fill(f.container, '[data-review-lookup]', 'org/c#new'); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true); expect(f.container.textContent).toContain('unsupported format'); expect(localStorage.getItem(key)).toBe('{"version":9}');
});
it('retains unknown fields in saved review target drafts instead of overwriting them', async () => {
  const key = 'helmsman.communication.v1:helmsman.communication/review-request:review-target'; const raw = JSON.stringify({ version: 1, lookup: 'org/b#42', target: { repo: 'org/b', number: 42 }, future: true }); localStorage.setItem(key, raw); const f = await fixture(request); await f.instance.refresh?.(); fill(f.container, '[data-review-lookup]', 'changed'); expect(localStorage.getItem(key)).toBe(raw); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true);
});
it('rejects malformed destinations without allowing submission or crashing the panel', async () => {
  const f = await fixture(request, {}, context => { vi.mocked(context.services.communication!.settings).mockResolvedValue(available({ ...snapshot, destination: { ...snapshot.destination!, channel: null } } as unknown as typeof snapshot)); }); await f.instance.refresh?.(); expect(f.container.textContent).toContain('Review destination unavailable'); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true);
});
it('allows an explicit new review request after historical success without erasing receipts or automatically submitting', async () => {
  const input: CommunicationCommandInputV1 = { version: 1, repo: 'org/b', number: 42, expectedDestination: snapshot.destination! }; const original = terminal(input); const key = `helmsman.communication.v1:helmsman.communication/review-request:result:org/b:${requestId}`; const raw = JSON.stringify(original); localStorage.setItem(key, raw);
  const f = await fixture(request); await f.instance.refresh?.(); const service = f.context.services.communicationCommands!; expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true);
  click(f.container, '[data-prepare-repeat]'); await ready(f); await f.instance.refresh?.(); for (const fn of [service.submit, service.retry, service.receipt, service.acknowledge]) expect(fn).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(raw);
  const nextId = 'ad1ce95e-5762-4ed9-9dc8-cbc680d9e1ee'; vi.mocked(service.submit).mockImplementation(async command => { const receipt = { ...terminal(command), requestId: nextId }; f.pending.push({ command: { ...command, requestId: nextId }, receipt }); return available(receipt); });
  click(f.container, '[data-send-review]'); await vi.waitFor(() => expect(service.acknowledge).toHaveBeenCalledWith({ repo: 'org/b', requestId: nextId })); expect(service.submit).toHaveBeenCalledTimes(1); expect(vi.mocked(service.submit).mock.calls[0]?.[0]).toEqual(input); expect(service.retry).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(raw); expect(f.container.querySelectorAll('.communication-saved-result')).toHaveLength(2); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true);
  f.lifetime.abort(); const restored = await fixture(request); await restored.instance.refresh?.(); expect(restored.container.querySelectorAll('.communication-saved-result')).toHaveLength(2); expect(restored.context.services.communicationCommands!.submit).not.toHaveBeenCalled(); expect(restored.container.querySelector<HTMLButtonElement>('[data-prepare-repeat]')?.disabled).toBe(false);
});
it('keeps pending retry identity and server cooldown authoritative when a prior request succeeded', async () => {
  const input: CommunicationCommandInputV1 = { version: 1, repo: 'org/b', number: 42, expectedDestination: snapshot.destination! }; const original = terminal(input); const key = `helmsman.communication.v1:helmsman.communication/review-request:result:org/b:${requestId}`; localStorage.setItem(key, JSON.stringify(original));
  const f = await fixture(request); await f.instance.refresh?.(); const service = f.context.services.communicationCommands!; click(f.container, '[data-prepare-repeat]'); const nextId = 'ad1ce95e-5762-4ed9-9dc8-cbc680d9e1ee';
  vi.mocked(service.submit).mockImplementation(async command => { f.pending.push({ command: { ...command, requestId: nextId }, receipt: null }); return { status: 'unavailable', reason: 'connection-failed' }; }); click(f.container, '[data-send-review]'); await vi.waitFor(() => expect(f.container.querySelector('[data-retry="true"]')).not.toBeNull()); expect(f.container.querySelector<HTMLButtonElement>('[data-prepare-repeat]')?.disabled).toBe(true); click(f.container, '[data-prepare-repeat]'); expect(service.submit).toHaveBeenCalledTimes(1);
  vi.mocked(service.retry).mockResolvedValue(available({ ...original, requestId: nextId, status: 'rejected', result: null, reason: 'Recent request cooldown remains active.' })); click(f.container, '[data-retry="true"]'); await vi.waitFor(() => expect(service.acknowledge).toHaveBeenCalledWith({ repo: 'org/b', requestId: nextId })); expect(service.retry).toHaveBeenCalledWith({ repo: 'org/b', requestId: nextId }, expect.any(AbortSignal)); expect(f.container.textContent).toContain('cooldown remains active'); expect(service.submit).toHaveBeenCalledTimes(1); expect(localStorage.getItem(key)).toBe(JSON.stringify(original)); expect(f.container.querySelector<HTMLButtonElement>('[data-send-review]')?.disabled).toBe(true);
});

it('shows optional OAuth connection state and requires an explicit account action', async () => {
  const connection = { version: 1 as const, providerId: 'helmsman.slack-companion/slack', revision: 'a'.repeat(64), status: 'connected' as const,
    message: 'Slack account connected.', accountLabel: '<operator>', redirectUri: 'https://helmsman.example/api/communication-connection/callback' };
  const status = vi.fn(async () => available(connection));
  const disconnect = vi.fn(async () => available({ ...connection, status: 'disconnected' as const, message: 'Connect your Slack account.', accountLabel: null }));
  const connect = vi.fn(); const check = vi.fn();
  const f = await fixture(settings, {}, context => {
    Object.assign(context.services.communication!, { connectionStatus: status, connect, disconnect, checkConnection: check });
  }, 'helmsman.communication/settings');
  await vi.waitFor(() => expect(f.container.textContent).toContain('Slack account connected.'));
  expect(f.container.querySelector('operator')).toBeNull();
  expect(f.container.querySelector<HTMLAnchorElement>('.communication-connection a')?.href).toBe('https://helmsman.example/communication');
  expect(f.container.querySelector<HTMLAnchorElement>('.communication-connection a')?.target).toBe('_blank');
  expect(f.container.querySelector<HTMLAnchorElement>('.communication-connection a')?.rel).toBe('noopener noreferrer');
  expect(f.container.querySelector<HTMLButtonElement>('[data-connection-action="connect"]')?.disabled).toBe(true);
  expect(connect).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
  click(f.container, '[data-connection-action="disconnect"]');
  await vi.waitFor(() => expect(f.container.textContent).toContain('Connect your Slack account.'));
  expect(disconnect).toHaveBeenCalledWith({ expectedRevision: connection.revision }, expect.any(AbortSignal));
  expect(f.context.services.communicationCommands!.submit).not.toHaveBeenCalled();
  expect(Object.values(localStorage).join('')).not.toContain('<operator>');
});

import { afterEach, expect, it, vi } from 'vitest';
import type { FeedbackCommandServiceV1, FeedbackPendingV1, PluginPageContext, PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
import page from './page';
import settings from './settings';
const destination = { id: 'github-issues:org/app', label: 'org/app issues', url: 'https://github.com/org/app/issues', revision: 'a'.repeat(64) };
const metadata = { version: '1', repo: 'org/project', page: 'feedback' };
const available = <T>(value: T) => ({ status: 'available' as const, value });
const controllers: AbortController[] = [];
afterEach(() => { for (const value of controllers.splice(0)) value.abort(); localStorage.clear(); document.body.replaceChildren(); });
async function fixture(module: PluginPageModule = page, configure?: (context: PluginPageContext, pending: FeedbackPendingV1[]) => void) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); controllers.push(lifetime);
  const state: PluginPageState = { repo: metadata.repo, themeId: 'dark', pirateMode: false, visible: true, pane: null }; const pending: FeedbackPendingV1[] = [];
  const service: FeedbackCommandServiceV1 = { version: 1, context: () => metadata, destination: vi.fn(async () => available(destination)), pending: vi.fn(async () => [...pending]), submit: vi.fn(), receipt: vi.fn(), retry: vi.fn(), acknowledge: vi.fn() };
  const context: PluginPageContext = { contributionId: 'helmsman.product-feedback/page', state, signal: lifetime.signal, navigate: vi.fn(), onDispose: vi.fn(), services: { version: 1, feedbackCommands: service } as PluginPageContext['services'] };
  configure?.(context, pending); const instance = await module.mount(container, context); await instance.refresh?.();
  return { container, service, instance, state, lifetime, context, pending };
}
function fill(root: HTMLElement, name: string, value: string) { const input = root.querySelector<HTMLInputElement>(`[name=${name}]`)!; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
it('preserves unsent drafts through reload and destination disable', async () => {
  const f = await fixture(); fill(f.container, 'title', 'My bug'); fill(f.container, 'body', 'My reproduction'); f.lifetime.abort();
  const next = await fixture(page, context => { vi.mocked(context.services!.feedbackCommands!.destination).mockResolvedValue(available(null)); });
  expect(next.container.querySelector<HTMLInputElement>('[name=title]')?.value).toBe('My bug'); expect(next.container.querySelector<HTMLTextAreaElement>('[name=body]')?.value).toBe('My reproduction'); expect(next.container.querySelector('[name=body]')?.getAttribute('aria-label')).toBe('Feedback'); expect(next.container.querySelector<HTMLButtonElement>('[type=submit]')?.disabled).toBe(true); expect(next.container.textContent).toContain('disabled or unavailable');
});
it('has no submission form by default when a destination is unavailable', async () => {
  const f = await fixture(page, context => { vi.mocked(context.services!.feedbackCommands!.destination).mockResolvedValue(available(null)); }); expect(f.container.querySelector('form')).toBeNull(); expect(f.service.submit).not.toHaveBeenCalled();
});
it('retains uncertain submissions and only retries the original identity on explicit action', async () => {
  const f = await fixture(page, (_context, pending) => { pending.push({ command: { version: 1, draftId: '12345678-1234-4123-8123-123456789abc', requestId: '22345678-1234-4123-8123-123456789abc', title: '<img src=x>', body: 'Original body', context: metadata, expectedDestination: destination }, receipt: null }); });
  expect(f.container.querySelector('form')).toBeNull(); expect(f.container.querySelector('img')).toBeNull(); expect(f.container.textContent).toContain('Original body'); expect(f.service.retry).not.toHaveBeenCalled();
  vi.mocked(f.service.retry).mockResolvedValue({ status: 'unavailable', reason: 'connection-failed' }); f.container.querySelector<HTMLButtonElement>('[data-check]')!.click();
  await vi.waitFor(() => expect(f.service.retry).toHaveBeenCalledWith({ requestId: '22345678-1234-4123-8123-123456789abc', repo: metadata.repo }, expect.any(AbortSignal))); expect(f.service.submit).not.toHaveBeenCalled();
});
it('fences submission when a pending read completes after hiding the page', async () => {
  const f = await fixture(); fill(f.container, 'title', 'My bug'); fill(f.container, 'body', 'Steps');
  let resolve!: (value: FeedbackPendingV1[]) => void; vi.mocked(f.service.pending).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  f.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await f.instance.update({ ...f.state, visible: false }); resolve([]); await Promise.resolve(); expect(f.service.submit).not.toHaveBeenCalled();
});
it('blocks invalid local drafts without overwriting their data', async () => {
  const key = `helmsman.product-feedback.v1:helmsman.product-feedback/page:${JSON.stringify(metadata.repo)}`; localStorage.setItem(key, '{"version":9}'); const f = await fixture(); expect(f.container.textContent).toContain('invalid'); expect(localStorage.getItem(key)).toBe('{"version":9}'); expect(f.service.submit).not.toHaveBeenCalled();
});
it('saves generic tracker settings with the displayed revision and never submits feedback', async () => {
  const snapshot = { version: 1 as const, revision: 'b'.repeat(64), selected: null, providers: [{ id: 'helmsman.feedback-github/issues', label: 'GitHub Issues', fields: { enabled: { type: 'boolean' as const, default: false }, repository: { type: 'string' as const, default: '', maxLength: 256 } }, values: { enabled: false, repository: '' } }] };
  const save = vi.fn(async () => available(snapshot)); const f = await fixture(settings, context => { Object.assign(context.services!, { feedbackSettings: { version: 1, snapshot: vi.fn(async () => available(snapshot)), save } }); });
  const select = f.container.querySelector<HTMLSelectElement>('[name=provider]')!; select.value = 'helmsman.feedback-github/issues'; select.dispatchEvent(new Event('change', { bubbles: true }));
  const repo = f.container.querySelector<HTMLInputElement>('[data-field=repository]')!; repo.value = 'org/app'; repo.dispatchEvent(new Event('input', { bubbles: true }));
  const enabled = f.container.querySelector<HTMLInputElement>('[data-field=enabled]')!; enabled.checked = true; enabled.dispatchEvent(new Event('input', { bubbles: true }));
  f.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ version: 1, expectedRevision: snapshot.revision, selected: 'helmsman.feedback-github/issues', values: { enabled: true, repository: 'org/app' } }, expect.any(AbortSignal))); expect(f.service.submit).not.toHaveBeenCalled();
});
it('retains a settings draft after a lost save response and requires explicit revision review before replay', async () => {
  const before = { version: 1 as const, revision: 'b'.repeat(64), selected: 'helmsman.feedback-github/issues', providers: [{ id: 'helmsman.feedback-github/issues', label: 'GitHub Issues', fields: { repository: { type: 'string' as const, default: '', maxLength: 256 } }, values: { repository: 'org/original' } }] };
  let snapshot = before;
  const save = vi.fn(async (input: { values: Readonly<Record<string, import('@helmsman/plugin-sdk').PluginJson>> }) => { snapshot = { ...before, revision: 'c'.repeat(64), providers: [{ ...before.providers[0]!, values: { repository: String(input.values.repository) } }] }; return { status: 'unavailable' as const, reason: 'connection-failed' as const }; });
  const configure = (context: PluginPageContext) => { Object.assign(context.services!, { feedbackSettings: { version: 1, snapshot: vi.fn(async () => available(snapshot)), save } }); };
  const f = await fixture(settings, configure); const repo = f.container.querySelector<HTMLInputElement>('[data-field=repository]')!; repo.value = 'org/revised'; repo.dispatchEvent(new Event('input', { bubbles: true })); f.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(f.container.textContent).toContain('not confirmed saved')); f.lifetime.abort();
  const restored = await fixture(settings, configure); expect(restored.container.querySelector<HTMLInputElement>('[data-field=repository]')?.value).toBe('org/revised'); expect(restored.container.querySelector<HTMLButtonElement>('[type=submit]')?.disabled).toBe(true); expect(save).toHaveBeenCalledTimes(1);
  restored.container.querySelector<HTMLButtonElement>('[data-rebase]')!.click(); expect(restored.container.querySelector<HTMLButtonElement>('[type=submit]')?.disabled).toBe(false); expect(save).toHaveBeenCalledTimes(1);
});
it('routes the independent footer entry using the selected scope and configured destination', async () => {
  const { default: footer } = await import('./footer'); const f = await fixture(footer);
  expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/product-feedback?repo=org%2Fproject');
  vi.mocked(f.service.destination).mockResolvedValue(available(null)); await f.instance.refresh?.();
  expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/feedback-settings?repo=org%2Fproject');
  f.container.querySelector('a')!.click(); expect(f.context.navigate).toHaveBeenCalledWith('/feedback-settings?repo=org%2Fproject');
});

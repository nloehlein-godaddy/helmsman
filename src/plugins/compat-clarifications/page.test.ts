import { afterEach, expect, it, vi } from 'vitest';
import type { PluginPageContext, PluginPageState } from '@helmsman/plugin-sdk';
import type { ClarificationViewServices } from './controller.js';
import page from './page.js';

const state: PluginPageState = { repo: 'org/project', themeId: 'dark', pirateMode: false, visible: true, pane: null };
const lifetimes: AbortController[] = [];
function fixture(contributionId: string | undefined) {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  const services = {
    clarifications: { version: 1, list: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'service-unavailable' as const })), load: vi.fn() },
    clarificationCommands: { version: 1, submit: vi.fn(), pending: vi.fn(async () => []), receipt: vi.fn(), acknowledge: vi.fn() },
    suggestedContacts: { version: 1, list: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'service-unavailable' as const })), load: vi.fn(), submit: vi.fn(), pending: vi.fn(async () => []), receipt: vi.fn(), acknowledge: vi.fn() },
  } satisfies ClarificationViewServices;
  const context: PluginPageContext = { contributionId, state, signal: lifetime.signal, services: services as unknown as PluginPageContext['services'], navigate: vi.fn(), onDispose: vi.fn() };
  return { container, lifetime, services, context };
}
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it.each([undefined, '', 'example/page', 'example.recovery/page:legacy'])('fails closed for missing or invalid host identity %s', async identity => {
  const f = fixture(identity); const read = vi.spyOn(Storage.prototype, 'getItem');
  await expect(async () => page.mount(f.container, f.context)).rejects.toThrow('contribution identity');
  expect(read).not.toHaveBeenCalled(); expect(f.services.clarifications.list).not.toHaveBeenCalled(); expect(f.container.innerHTML).toBe('');
});

it('requires public services without falling back to private clients or draft reads', async () => {
  const f = fixture('helmsman.compat-clarifications/page'); const read = vi.spyOn(Storage.prototype, 'getItem');
  await expect(async () => page.mount(f.container, { ...f.context, services: undefined })).rejects.toThrow('services are unavailable');
  expect(read).not.toHaveBeenCalled(); expect(f.container.innerHTML).toBe('');
});

it('uses injected identity for copied draft storage without reading or changing unknown original evidence', async () => {
  const originalKey = 'helmsman.compat-clarifications.drafts.v2:future-format'; const evidence = '{"version":99,"opaque":"keep"}';
  localStorage.setItem(originalKey, evidence);
  const f = fixture('example.recovery/page'); const instance = await page.mount(f.container, f.context);
  await instance.refresh?.(); expect(f.container.textContent).not.toContain('Draft or result storage unavailable');
  const input = f.container.querySelector<HTMLInputElement>('.trusted-contact-form [name="name"]')!;
  input.value = 'Copied draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(JSON.parse(localStorage.getItem('helmsman.clarification-recovery.drafts.v2:example.recovery/page:contact') ?? 'null')).toMatchObject({ name: 'Copied draft' });
  expect(localStorage.getItem(originalKey)).toBe(evidence); expect(f.services.suggestedContacts.submit).not.toHaveBeenCalled();
  instance.dispose(); const original = fixture('helmsman.compat-clarifications/page'); await page.mount(original.container, original.context);
  expect(original.container.textContent).toContain('Draft or result storage unavailable'); expect(localStorage.getItem(originalKey)).toBe(evidence);
});

it('uses public navigation and updates package terminology without translating user content', async () => {
  const f = fixture('example.recovery/page'); const instance = await page.mount(f.container, f.context);
  await instance.refresh?.(); expect(f.container.querySelector('.clarification-help a')?.textContent).toBe('start a run');
  f.container.querySelector<HTMLAnchorElement>('.clarification-help a')!.click();
  expect(f.context.navigate).toHaveBeenCalledWith('/helm?repo=org%2Fproject&pane=newrun');
  await instance.update({ ...state, pirateMode: true });
  expect(f.container.querySelector('.clarification-help a')?.textContent).toBe('start a voyage');
  expect(f.container.querySelector('style')?.textContent).toContain('.plugin-clarification-recovery');
});

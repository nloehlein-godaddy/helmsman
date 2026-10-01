import { afterEach, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import questionsPackage from './plugins/clarifications/plugin-package.json';
import { appPages } from './plugins/builtins';
import { appPageModules, syncBuiltinFrontend } from './plugins/builtin-modules';
import { CLARIFICATIONS_PAGE_SLOT } from './plugins/page-slots';
import type { PluginPageAttentionContext } from './plugins/sdk';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); appPages.select(CLARIFICATIONS_PAGE_SLOT, null); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });
it('uses the selected replacement contribution, suppresses alias and canonical visits, and aborts on disablement', async () => {
  syncBuiltinFrontend([], true); document.body.innerHTML = '<div id="app"></div>'; window.history.replaceState(null, '', '/config?repo=org/a');
  cleanup.push(appPages.register({ ...questionsPackage.manifest, id: 'example.questions', version: '1.0.0', panels: [], pages: [{ ...questionsPackage.manifest.pages[0], title: 'Custom questions' }] }));
  appPages.select(CLARIFICATIONS_PAGE_SLOT, 'example.questions/page');
  const attention = vi.fn(async (context: PluginPageAttentionContext) => ({ version: 1 as const, keys: [JSON.stringify([context.repo, 'question'])] }));
  const remove = appPageModules.register('example.questions/page', { attention, mount: () => ({ update() {}, dispose() {} }) }); cleanup.push(remove);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/api/context') return Response.json({ repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null });
    if (path === '/api/agents') return Response.json({ runs: [], autoClaim: [], caps: {} });
    if (path === '/api/config') return Response.json({ config: {}, overridden: [] });
    return new Response('', { status: 503 });
  }));
  const root = document.querySelector<HTMLElement>('#app')!; const view = new DashboardView(root); cleanup.push(() => view.destroy()); await view.start();
  const tab = () => root.querySelector('#page-tab-clarifications')!;
  await vi.waitFor(() => expect(tab().classList.contains('needs-attention')).toBe(true));
  expect(attention).toHaveBeenLastCalledWith(expect.objectContaining({ contributionId: 'example.questions/page', repo: 'org/a' }));
  (tab() as HTMLAnchorElement).click(); await vi.waitFor(() => expect(tab().getAttribute('aria-selected')).toBe('true')); expect(tab().classList.contains('needs-attention')).toBe(false);
  root.querySelector<HTMLAnchorElement>('#page-tab-config')!.click(); await vi.waitFor(() => expect(tab().classList.contains('needs-attention')).toBe(true));
  const direct = document.createElement('a'); direct.className = 'app-link'; direct.href = '/plugins/example.questions/page?repo=org/a'; root.append(direct); direct.click();
  await vi.waitFor(() => expect(window.location.pathname).toBe('/plugins/example.questions/page')); expect(tab().classList.contains('needs-attention')).toBe(false);
  root.querySelector<HTMLAnchorElement>('#page-tab-config')!.click(); await vi.waitFor(() => expect(tab().classList.contains('needs-attention')).toBe(true));
  const signal = attention.mock.calls.at(-1)![0].signal; const selector = root.querySelector<HTMLSelectElement>('.repo-select')!; selector.value = 'org/b'; selector.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(attention).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'org/b' }))); expect(signal.aborted).toBe(true);
  const last = attention.mock.calls.at(-1)![0].signal; remove(); expect(last.aborted).toBe(true); expect(tab().classList.contains('needs-attention')).toBe(false);
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/clarification'))).toBe(false);
});

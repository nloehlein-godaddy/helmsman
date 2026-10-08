import feedbackFooter from './plugins/product-feedback/footer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import { appPages, PRODUCT_FEEDBACK_FOOTER_SLOT, PROFILE_HEADER_SLOT } from './plugins/builtins';
import { appPageModules } from './plugins/builtin-modules';
import profileHeader from './plugins/profile/header';

const json = (value: unknown) => new Response(JSON.stringify(value));
let view: DashboardView | undefined;
const disposers: (() => void)[] = [];
let resolveProfile: ((value: Response) => void) | undefined;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
  window.history.replaceState(null, '', '/config?repo=org/app');
  const profile = new Promise<Response>(resolve => { resolveProfile = resolve; });
  disposers.push(appPages.register({manifestVersion:2,sdkVersion:1,id:'example.profile',version:'1.0.0',panels:[],pages:[{id:'header',title:'Profile',slots:[PROFILE_HEADER_SLOT],panes:[],navigation:false,requires:[{id:'helmsman/profile',version:1}]}]}));
  disposers.push(appPageModules.register('example.profile/header', profileHeader));
  appPages.select(PROFILE_HEADER_SLOT, 'example.profile/header');
  const snapshot = await loadDashboard();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/profile') return profile;
    if (url.pathname === '/api/context') return json({ repos: ['org/app', 'org/other'], jiraBaseUrl: null });
    if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
    if (url.pathname === '/api/dashboard') return json({ snapshot, repos: ['org/app', 'org/other'], selectedRepo: url.searchParams.get('repo'), degraded: [], jiraBaseUrl: null });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/pr') return json({ number: Number(url.searchParams.get('number')), repo: url.searchParams.get('repo'), state: 'open', isOwnPr: true, draft: false, merged: false, headRefName: 'topic', reviewDecision: '', comments: 0, checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/app/pull/42' });
    if (url.pathname === '/api/pr/diff') return json({ files: [] });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => {
  view?.destroy();
  view = undefined;
  appPages.select(PROFILE_HEADER_SLOT, null);
  appPages.select(PRODUCT_FEEDBACK_FOOTER_SLOT, null);
  disposers.splice(0).reverse().forEach(dispose => dispose());
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const start = async () => {
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
  await view.start();
};
const toggle = (enabled: boolean) => {
  const control = document.querySelector<HTMLButtonElement>('.app-footer button[data-pirate-mode]');
  expect(control).not.toBeNull();
  if (control?.getAttribute('aria-pressed') !== String(enabled)) control?.click();
};

describe('Pirate mode and greeting', () => {

  it('defaults on, switches immediately, preserves unsaved settings and persists across reloads', async () => {
    await start();
    expect(document.querySelector<HTMLButtonElement>('.app-footer button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    const settings = document.querySelector<HTMLInputElement>('[data-key="MAX_ATTEMPTS"] input')!;
    settings.value = '7';
    toggle(false);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('PRs');
    expect(document.querySelector('[data-view="dashboard"]')?.textContent).toBe('Dashboard');
    expect(document.querySelector('.repo-select')?.getAttribute('aria-label')).toBe('Scope by repository');
    expect(document.querySelector('.helm-readout')?.getAttribute('aria-label')).toBe('System status');
    expect(document.querySelector('.page-intro p')?.textContent).toContain('agent defaults');
    expect(document.querySelector('[data-footer-running]')?.textContent).toBe('0 running');
    expect(document.querySelector<HTMLInputElement>('[data-key="MAX_ATTEMPTS"] input')?.value).toBe('7');
    expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/app');
    expect(localStorage.getItem('helmsman.pirateMode')).toBe('false');
    view?.destroy();
    await start();
    expect(document.querySelector<HTMLButtonElement>('.app-footer button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe('false');
    toggle(true);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    expect(document.querySelector('.page-intro p')?.textContent).toContain('deckhand defaults');
    expect(document.querySelector('.helm-readout')?.getAttribute('aria-label')).toBe('Fleet status');
    expect(document.activeElement).toBe(document.querySelector('.app-footer [data-pirate-mode]'));
  });

  it('adds an escaped GitHub name without replacing unsaved fields and changes the salutation with the mode', async () => {
    await start();
    const settings = document.querySelector<HTMLInputElement>('[data-key="MAX_ATTEMPTS"] input')!;
    settings.value = '9';
    resolveProfile?.(json({ version:1,scope:'global',profile:{ displayName: 'Pat <img src=x>', login: 'pat' } }));
    await vi.waitFor(() => expect(document.querySelector('.helm-greeting')?.textContent).toBe('Ahoy, Pat <img src=x>!'));
    expect(document.querySelector('.helm-greeting img')).toBeNull();
    expect(document.querySelector('[data-key="MAX_ATTEMPTS"] input')).toBe(settings);
    expect(settings.value).toBe('9');
    toggle(false);
    expect(document.querySelector('.helm-greeting')?.textContent).toBe('Hello, Pat <img src=x>!');
  });


  it('keeps pending config saves and their failure feedback intact', async () => {
    await start();
    let finishSave!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finishSave = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => pending);
    const save = document.querySelector<HTMLButtonElement>('[data-key="MAX_ATTEMPTS"] .config-save')!;
    save.click();
    expect(save.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.app-footer button[data-pirate-mode]')?.disabled).toBe(true);
    toggle(false);
    expect(document.querySelector('[data-key="MAX_ATTEMPTS"] .config-save')).toBe(save);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    finishSave(new Response(JSON.stringify({ error: 'Unable to save settings' }), { status: 500 }));
    await vi.waitFor(() => expect(document.querySelector('[data-key="MAX_ATTEMPTS"] .config-error')?.textContent).toBe('Unable to save settings'));
    expect(document.querySelector<HTMLButtonElement>('.app-footer button[data-pirate-mode]')?.disabled).toBe(false);
    toggle(false);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('PRs');
  });

  it('uses the handle when the profile has no display name', async () => {
    await start();
    resolveProfile?.(json({ version:1,scope:'global',profile:{ displayName: null, login: 'captain-pat' } }));
    await vi.waitFor(() => expect(document.querySelector('.helm-greeting')?.textContent).toBe('Ahoy, captain-pat!'));
  });
});

it('retains the scoped feedback footer after replacing the Pirate mode controls', async () => {
  disposers.push(appPages.register({ manifestVersion: 2, sdkVersion: 1, id: 'example.feedback', version: '1.0.0', panels: [], pages: [{ id: 'footer', title: 'Product feedback', slots: [PRODUCT_FEEDBACK_FOOTER_SLOT], panes: [], navigation: false, requires: [{ id: 'helmsman/feedback-command', version: 1 }] }] }));
  disposers.push(appPageModules.register('example.feedback/footer', feedbackFooter)); appPages.select(PRODUCT_FEEDBACK_FOOTER_SLOT, 'example.feedback/footer');
  await start();
  const assertFooter = () => expect(document.querySelector('.footer-controls [data-product-feedback]')?.getAttribute('href')).toBe('/feedback-settings?repo=org%2Fapp');
  await vi.waitFor(assertFooter); toggle(false); await vi.waitFor(assertFooter); toggle(true); await vi.waitFor(assertFooter);
});

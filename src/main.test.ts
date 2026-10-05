import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { DashboardResponse } from './data/live';
import { DEFAULT_THEME_ID, getTheme } from './data/themes';

const views: DashboardView[] = [];
function createView(root: HTMLElement): DashboardView {
  const view = new DashboardView(root);
  views.push(view);
  return view;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed: boolean = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

const realEventSource: typeof globalThis.EventSource | undefined = globalThis.EventSource;
const realFetch: typeof globalThis.fetch | undefined = globalThis.fetch;

async function buildResponse(): Promise<DashboardResponse> {
  const snapshot = await loadMockSnapshot();
  return { snapshot, degraded: [], repos: [snapshot.repo], selectedRepo: null, jiraBaseUrl: null };
}

describe('DashboardView settings interactions', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
    document.body.innerHTML = '<div id="app"></div>';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
    window.history.replaceState(null, '', '/helm');
  });

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
    globalThis.fetch = realFetch as typeof globalThis.fetch;
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('saves a config value and refreshes', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config') && init?.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: { AGENT_MAX_ATTEMPTS: 1 }, overridden: [] }),
        } as unknown as Response;
      }
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.page-tab[data-view="config"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.config-row[data-key="AGENT_MAX_ATTEMPTS"]')).not.toBeNull());

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"]');
    expect(row).not.toBeNull();
    const input: HTMLInputElement = row!.querySelector<HTMLInputElement>('.config-input')!;
    input.value = '2';
    row!.querySelector<HTMLButtonElement>('.config-save')!.click();

    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([requestInput, requestInit]) =>
            String(requestInput).includes('/api/config') && (requestInit as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true);
    });

    const putCall = fetchMock.mock.calls.find(
      ([requestInput, requestInit]) =>
        String(requestInput).includes('/api/config') && (requestInit as RequestInit | undefined)?.method === 'PUT',
    );
    const putBody: unknown = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(putBody).toEqual({ key: 'AGENT_MAX_ATTEMPTS', value: '2' });
  });

  it('shows an inline error and skips refresh when a config save fails', async () => {
    const response: DashboardResponse = await buildResponse();
    let configGetCalls: number = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config') && init?.method === 'PUT') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid setting' }),
        } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        configGetCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: { AGENT_MAX_ATTEMPTS: 1 }, overridden: [] }),
        } as unknown as Response;
      }
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();
    expect(configGetCalls).toBe(1);

    root.querySelector<HTMLButtonElement>('.page-tab[data-view="config"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.config-row[data-key="AGENT_MAX_ATTEMPTS"]')).not.toBeNull());
    const afterEnter: number = configGetCalls;

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"]');
    expect(row).not.toBeNull();
    const input: HTMLInputElement = row!.querySelector<HTMLInputElement>('.config-input')!;
    input.value = 'not-a-valid-limit';
    row!.querySelector<HTMLButtonElement>('.config-save')!.click();

    await vi.waitFor(() => {
      expect(row!.querySelector<HTMLElement>('.config-error')?.textContent).toBe('invalid setting');
    });
    expect(configGetCalls).toBe(afterEnter);
  });

  it('does not expose an auto-claim toggle or mutate auto-claim when viewing a scoped repo', async () => {
    const response: DashboardResponse = await buildResponse();
    const scopedResponse: DashboardResponse = { ...response, repos: ['org/alpha'], selectedRepo: 'org/alpha' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/auto-claim')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [], autoClaim: ['org/alpha'] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => scopedResponse } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    expect(root.querySelector('.auto-claim-toggle')).toBeNull();
    expect(fetchMock.mock.calls.some(([requestInput]) => String(requestInput).includes('/auto-claim'))).toBe(false);
    view.destroy();
  });

  it('applies the persisted theme to documentElement before the first paint', async () => {
    localStorage.setItem('cmux.theme', 'dracula');
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);

    expect(document.documentElement.dataset.theme).toBe('dracula');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(getTheme('dracula')?.vars['--accent']);

    await view.refresh();
    expect(root.querySelector('.theme-select')).toBeNull();
    root.querySelector<HTMLAnchorElement>('.page-tab[data-view="config"]')?.click();
    await vi.waitFor(() => expect(root.querySelector('.ui-customization-panel .theme-select')).not.toBeNull());
    const select: HTMLSelectElement | null = root.querySelector<HTMLSelectElement>('.theme-select');
    expect(select!.value).toBe('dracula');
    view.destroy();
  });

  it('defaults to the Quarterdeck theme when nothing is persisted', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    void createView(root);

    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(getTheme(DEFAULT_THEME_ID)?.vars['--accent']);
  });

  it('applies and persists a new theme on select change without a full data refetch', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    expect(root.querySelector('.theme-select')).toBeNull();
    root.querySelector<HTMLAnchorElement>('.page-tab[data-view="config"]')?.click();
    await vi.waitFor(() => expect(root.querySelector('.ui-customization-panel .theme-select')).not.toBeNull());
    const select: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.theme-select')!;
    const preview = root.querySelector('.theme-preview');
    expect(preview).not.toBeNull();
    const callsBefore: number = fetchMock.mock.calls.length;

    select.value = 'nord';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(getTheme('nord')?.vars['--accent']);
    expect(localStorage.getItem('cmux.theme')).toBe('nord');
    expect(root.querySelector('.theme-preview')).toBe(preview);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    view.destroy();
  });

  it.each([1024, 390])('moves tab focus with orientation-aware arrows at %ipx without navigating until Space activates it', async width => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
    const forward = width > 840 ? 'ArrowDown' : 'ArrowRight';
    const backward = width > 840 ? 'ArrowUp' : 'ArrowLeft';
    const response = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true, status: 200,
      json: async () => String(input).includes('/api/config') ? { config: {}, overridden: [] } : response,
    }) as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const root = document.querySelector<HTMLElement>('#app')!;
    const view = createView(root);
    await view.refresh();
    const tabs = Array.from(root.querySelectorAll<HTMLAnchorElement>('.page-tab'));
    const dashboard = tabs[0];
    if (!dashboard) throw new Error('Missing dashboard tab');
    expect(root.querySelector('.page-tabs')?.getAttribute('aria-orientation')).toBe(width > 840 ? 'vertical' : 'horizontal');
    dashboard.focus();
    const callsBefore = fetchMock.mock.calls.length;
    const press = (key: string): void => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };

    const perpendicular = new KeyboardEvent('keydown', { key: width > 840 ? 'ArrowRight' : 'ArrowDown', bubbles: true, cancelable: true });
    dashboard.dispatchEvent(perpendicular);
    expect(perpendicular.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(dashboard);
    press(forward);
    expect(document.activeElement).toBe(tabs[1]);
    press(backward);
    expect(document.activeElement).toBe(dashboard);
    press(backward);
    expect(document.activeElement).toBe(tabs.at(-1));
    press(forward);
    expect(document.activeElement).toBe(dashboard);
    press('End');
    expect(document.activeElement).toBe(tabs.at(-1));
    press('Home');
    expect(document.activeElement).toBe(dashboard);
    expect(dashboard.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('#page-content')?.getAttribute('aria-labelledby')).toBe(dashboard.id);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    press('End');
    const destination = document.activeElement as HTMLAnchorElement;
    expect(root.querySelectorAll('.page-tab[tabindex="0"]')).toHaveLength(1);
    expect(destination.tabIndex).toBe(0);
    expect(destination.getAttribute('aria-selected')).toBe('false');
    press(' ');
    await vi.waitFor(() => expect(root.querySelector('#page-content')?.getAttribute('aria-labelledby')).toBe(destination.id));
    expect(root.querySelector(`#${destination.id}`)?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector(`#${destination.id}`));
    expect(root.querySelector('#page-content')?.contains(root.querySelector('.ui-customization-panel'))).toBe(true);
    press('Home');
    await view.refresh();
    expect(document.activeElement).toBe(root.querySelector('#page-tab-dashboard'));
    expect(root.querySelector('#page-tab-dashboard')?.getAttribute('tabindex')).toBe('0');
    expect(root.querySelector('#page-tab-config')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelectorAll('.page-tab[tabindex="0"]')).toHaveLength(1);
    view.destroy();
    vi.restoreAllMocks();
  });
});

describe('DashboardView retained galleon scope', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
    document.body.innerHTML = '<div id="app"></div>';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
    window.history.replaceState(null, '', '/helm');
  });

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
    globalThis.fetch = realFetch as typeof globalThis.fetch;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('persists galleon scope and restores the header on a fresh view', async () => {
    const response: DashboardResponse = await buildResponse();
    const scoped: string[] = ['acme/widgets', 'acme/other'];
    response.repos = scoped;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/dashboard')) {
        const match: RegExpMatchArray | null = url.match(/repo=([^&]+)/);
        const repo: string | null = match ? decodeURIComponent(match[1]) : null;
        return { ok: true, status: 200, json: async () => ({ ...response, repos: scoped, selectedRepo: repo }) } as unknown as Response;
      }
      if (url.includes('/api/agents')) return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    const select: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'acme/other';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(localStorage.getItem('runner.repoScope')).toBe('acme/other'));

    view.destroy();
    document.body.innerHTML = '<div id="app"></div>';
    const root2: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view2: DashboardView = createView(root2);
    await view2.start();
    expect(root2.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('acme/other');
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('acme/other');
  });


});

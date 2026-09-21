import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { DashboardResponse } from './data/live';
import type { CmuxTabView } from './logic/cmuxPanel';
import { DEFAULT_THEME_ID } from './data/themes';

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

function cmuxTab(over: Partial<CmuxTabView> = {}): CmuxTabView {
  return {
    windowRef: 'win-1',
    workspaceRef: 'ws-1',
    workspaceTitle: 'helmsman',
    surfaceRef: 'surface-1',
    surfaceTitle: 'main',
    type: 'shell',
    cwd: '/repo',
    selected: false,
    ...over,
  };
}

describe('DashboardView settings and terminal interactions', () => {
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
          json: async () => ({ config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] }),
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
    await vi.waitFor(() => expect(root.querySelector('.config-row[data-key="AGENT_ADAPTER"]')).not.toBeNull());

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
    expect(row).not.toBeNull();
    const input: HTMLInputElement = row!.querySelector<HTMLInputElement>('.config-input')!;
    input.value = 'codex';
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
    expect(putBody).toEqual({ key: 'AGENT_ADAPTER', value: 'codex' });
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
          json: async () => ({ error: 'invalid adapter' }),
        } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        configGetCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] }),
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
    await vi.waitFor(() => expect(root.querySelector('.config-row[data-key="AGENT_ADAPTER"]')).not.toBeNull());
    const afterEnter: number = configGetCalls;

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
    expect(row).not.toBeNull();
    const input: HTMLInputElement = row!.querySelector<HTMLInputElement>('.config-input')!;
    input.value = 'not-a-real-adapter';
    row!.querySelector<HTMLButtonElement>('.config-save')!.click();

    await vi.waitFor(() => {
      expect(row!.querySelector<HTMLElement>('.config-error')?.textContent).toBe('invalid adapter');
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

  it('keeps the cmux-input node and its value untouched when an SSE tabs-changed event reports an unchanged tab set', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    let tabsCallCount: number = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        tabsCallCount += 1;
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const input: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'draft command';
    input.focus();
    expect(document.activeElement).toBe(input);

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const callsBeforeEvent: number = tabsCallCount;
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ kind: 'cmux-tabs-changed' }),
    } as MessageEvent<string>);
    await vi.waitFor(() => expect(tabsCallCount).toBe(callsBeforeEvent + 1));

    const inputAfter: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    expect(inputAfter).toBe(input);
    expect(inputAfter.value).toBe('draft command');
    expect(document.activeElement).toBe(inputAfter);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('preserves the typed cmux-input value and focus across a repaint triggered by an actual tab-set change', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const tabTwo: CmuxTabView = cmuxTab({ surfaceRef: 'surface-2', surfaceTitle: 'second' });
    let tabsCallCount: number = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        tabsCallCount += 1;
        const tabs: CmuxTabView[] = tabsCallCount <= 1 ? [tabOne] : [tabOne, tabTwo];
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const input: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'draft command';
    input.focus();

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ kind: 'cmux-tabs-changed' }),
    } as MessageEvent<string>);

    await vi.waitFor(() => expect(root.querySelectorAll('.cmux-tab').length).toBe(2));

    const inputAfter: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    expect(inputAfter.value).toBe('draft command');
    expect(document.activeElement).toBe(inputAfter);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('shows a placeholder instead of a stale screen when /api/cmux/screen 404s', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: false, status: 404, json: async () => ({ error: 'internal_error' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.cmux-screen')?.textContent).toContain('Screen unavailable');
    });

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('keeps the typed cmux-input value and shows an error when a send fails', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/send')) {
        return { ok: false, status: 400, json: async () => ({ error: 'send failed' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const input: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'draft command';
    root.querySelector<HTMLButtonElement>('.cmux-send button[type="submit"]')!.click();

    await vi.waitFor(() => expect(root.querySelector('.cmux-error')).not.toBeNull());
    expect(root.querySelector('.cmux-error')?.textContent).toBe('send failed');
    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('draft command');

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('uploads a pasted clipboard image to the active surface', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const pasteCalls: Array<{ surface?: string; dataBase64?: string; ext?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/paste-image')) {
        pasteCalls.push(JSON.parse(String(init?.body ?? '{}')));
        return { ok: true, status: 200, json: async () => ({ ok: true, path: '/tmp/x.png' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const file: File = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
    const ev: Event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ type: 'image/png', getAsFile: () => file }] },
    });
    root.querySelector<HTMLInputElement>('.cmux-input')!.dispatchEvent(ev);

    await vi.waitFor(() => expect(pasteCalls.length).toBe(1));
    expect(pasteCalls[0]).toMatchObject({ surface: tabOne.surfaceRef, dataBase64: 'AQID', ext: 'png' });

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('re-enables the action button and shows an error when a cmux action fails', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/action')) {
        return { ok: false, status: 400, json: async () => ({ error: 'action failed' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.cmux-action')).not.toBeNull());

    const actionBtn: HTMLButtonElement = root.querySelector<HTMLButtonElement>('.cmux-action')!;
    actionBtn.click();

    await vi.waitFor(() => expect(root.querySelector('.cmux-error')).not.toBeNull());
    expect(root.querySelector('.cmux-error')?.textContent).toBe('action failed');
    expect(actionBtn.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('reports invalid terminal data and retries without losing a selected tab draft', async () => {
    const response = await buildResponse();
    const tab = cmuxTab();
    let tabsPayload: unknown = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      const payload = url.includes('/api/cmux/tabs') ? tabsPayload
        : url.includes('/api/cmux/screen') ? { text: 'Ready' } : response;
      return new Response(JSON.stringify(payload));
    }) as typeof globalThis.fetch;
    const root = document.querySelector<HTMLElement>('#app')!;
    const view = createView(root);
    await view.refresh();
    root.querySelector<HTMLAnchorElement>('[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('could not be refreshed'));
    tabsPayload = { connected: true, tabs: [tab] };
    root.querySelector<HTMLButtonElement>('[data-cmux-refresh]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-input')).not.toBeNull());
    const input = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'Unsent command';
    input.focus();
    tabsPayload = { connected: true, tabs: [null] };
    const stream = FakeEventSource.instances.find(item => item.url === '/api/cmux/events');
    stream?.onmessage?.({ data: JSON.stringify({ kind: 'cmux-tabs-changed' }) } as MessageEvent<string>);
    await vi.waitFor(() => expect(root.querySelector('[data-cmux-refresh]')).not.toBeNull());
    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('Unsent command');
    expect(document.activeElement).toBe(root.querySelector('.cmux-input'));
    tabsPayload = { connected: true, tabs: [tab] };
    root.querySelector<HTMLButtonElement>('[data-cmux-refresh]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-cmux-refresh]')).toBeNull());
    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('Unsent command');
    view.destroy();
  });

  it('sends a mapped key and prevents default when capturing and a surface is selected', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const keyCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [{ ...tabOne }] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/key')) {
        keyCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());

    root.querySelector<HTMLInputElement>('.cmux-input')!.value = 'Unsent command';
    root.querySelector<HTMLButtonElement>('[data-cmux-capture]')!.click();
    expect(root.querySelector<HTMLElement>('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('true');

    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('Unsent command');
    expect(document.activeElement).toBe(root.querySelector('.cmux-screen'));
    tabOne.surfaceTitle = 'Renamed while controlling';
    const stream = FakeEventSource.instances.find(item => item.url === '/api/cmux/events');
    stream?.onmessage?.({ data: JSON.stringify({ kind: 'cmux-tabs-changed' }) } as MessageEvent<string>);
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab-title')?.textContent).toBe(tabOne.surfaceTitle));
    expect(document.activeElement).toBe(root.querySelector('.cmux-screen'));
    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('Unsent command');

    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true, bubbles: true });
    root.querySelector<HTMLElement>('.cmux-screen')!.dispatchEvent(event);

    await vi.waitFor(() => expect(keyCalls.length).toBe(1));
    expect(keyCalls[0]).toEqual({ surface: tabOne.surfaceRef, key: 'up' });
    expect(event.defaultPrevented).toBe(true);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, cancelable: true, bubbles: true });
    root.querySelector<HTMLElement>('.cmux-screen')!.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('Unsent command');
    expect(root.querySelector('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(root.querySelector('[data-cmux-capture]'));
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    document.activeElement?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(keyCalls).toHaveLength(1);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('sends printable text without enter when capturing', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const sendCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/send')) {
        sendCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('[data-cmux-capture]')!.click();

    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'a', cancelable: true, bubbles: true });
    root.querySelector<HTMLElement>('.cmux-screen')!.dispatchEvent(event);

    await vi.waitFor(() => expect(sendCalls.length).toBe(1));
    expect(sendCalls[0]).toEqual({ surface: tabOne.surfaceRef, text: 'a', enter: false });
    expect(event.defaultPrevented).toBe(true);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('does nothing on keydown when capture is off', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('false');

    const callsBefore: number = fetchMock.mock.calls.length;
    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true, bubbles: true });
    root.querySelector<HTMLElement>('.cmux-screen')!.dispatchEvent(event);
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(event.defaultPrevented).toBe(false);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('sends a key from the nav keypad button click', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const keyCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/key')) {
        keyCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.cmux-keypad-btn')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-keypad-btn[data-key="down"]')!.click();

    await vi.waitFor(() => expect(keyCalls.length).toBe(1));
    expect(keyCalls[0]).toEqual({ surface: tabOne.surfaceRef, key: 'down' });

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it.each(['.cmux-input', '[data-cmux-capture]', '.repo-select'])('leaves controls outside terminal capture usable: %s', async selector => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('[data-cmux-capture]')!.click();
    expect(root.querySelector<HTMLElement>('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('true');

    const sendInput = root.querySelector<HTMLElement>(selector)!;
    sendInput.focus();
    expect(document.activeElement).toBe(sendInput);

    const callsBefore: number = fetchMock.mock.calls.length;
    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true, bubbles: true });
    sendInput.dispatchEvent(event);
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(event.defaultPrevented).toBe(false);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('applies the persisted theme to documentElement before the first paint', async () => {
    localStorage.setItem('cmux.theme', 'dracula');
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = createView(root);

    expect(document.documentElement.dataset.theme).toBe('dracula');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#bd93f9');

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
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#dfb778');
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
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#88c0d0');
    expect(localStorage.getItem('cmux.theme')).toBe('nord');
    expect(root.querySelector('.theme-preview')).toBe(preview);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    view.destroy();
  });

  it('moves tab focus with arrows and Home/End without navigating until Space activates it', async () => {
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
    dashboard.focus();
    const callsBefore = fetchMock.mock.calls.length;
    const press = (key: string): void => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };

    press('ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    press('ArrowLeft');
    expect(document.activeElement).toBe(dashboard);
    press('ArrowLeft');
    expect(document.activeElement).toBe(tabs.at(-1));
    press('ArrowRight');
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

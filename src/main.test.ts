import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { DashboardResponse } from './data/live';
import { DEFAULT_THEME_ID } from './data/themes';
import { createThemeRecipeFromPalette, DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from './data/themeGenerator';
import { THEME_PALETTE_PRESETS, type ThemePalettePreset } from './data/themePresets';

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

  it('disregards retired themes and applies the generated default before first paint', async () => {
    localStorage.setItem('cmux.theme', 'dracula');
    const root = document.querySelector<HTMLElement>('#app')!;
    createView(root);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark').accent);
  });

  async function openThemeEditor(): Promise<{ root: HTMLElement; fetchMock: ReturnType<typeof vi.fn> }> {
    const response = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({ ok: true, status: 200, json: async () => String(input).includes('/api/config') ? { config: {}, overridden: [] } : response }) as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const root = document.querySelector<HTMLElement>('#app')!;
    const view = createView(root);
    await view.refresh();
    root.querySelector<HTMLAnchorElement>('.page-tab[data-view="config"]')?.click();
    await vi.waitFor(() => expect(root.querySelector('[data-custom-theme-setting="hue"]')).not.toBeNull());
    return { root, fetchMock };
  }

  it('updates the generated theme live without replacing sliders, losing focus, or fetching data', async () => {
    const { root, fetchMock } = await openThemeEditor();
    const slider = root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')!;
    const preview = root.querySelector('.theme-preview');
    slider.focus();
    const callsBefore = fetchMock.mock.calls.length;
    slider.value = '270';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 270 }, 'dark').accent);
    expect(root.querySelector('[data-custom-theme-setting="hue"]')).toBe(slider);
    expect(document.activeElement).toBe(slider);
    expect(root.querySelector('[data-custom-theme-setting-output="hue"]')?.textContent).toBe('270°');
    expect(root.querySelector('.theme-preview')).toBe(preview);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')?.disabled).toBe(false);
    expect(localStorage.getItem('cmux.theme.custom')).toBeNull();
  });

  it('keeps advanced overrides through generator changes and clears them explicitly', async () => {
    const { root } = await openThemeEditor();
    const color = root.querySelector<HTMLInputElement>('[data-custom-theme-color="controlBg"]')!;
    color.value = '#ffffff';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    const slider = root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')!;
    slider.value = '280';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(color.value).toBe('#ffffff');
    expect(document.documentElement.style.getPropertyValue('--control-bg')).toBe('#ffffff');
    expect(root.querySelector<HTMLButtonElement>('[data-custom-theme-reset-overrides]')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-custom-theme-reset-overrides]')!.click();
    expect(document.documentElement.style.getPropertyValue('--control-bg')).toBe(generateThemePalette({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 280 }, 'dark').controlBg);
    expect(root.querySelector<HTMLButtonElement>('[data-custom-theme-reset-overrides]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')?.value).toBe('280');
  });

  it('keeps the wheel, sliders, overrides, and save state synchronized without replacing the editor', async () => {
    const { root, fetchMock } = await openThemeEditor();
    const wheel = root.querySelector<HTMLElement>('[data-custom-theme-wheel]')!;
    const hue = root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')!;
    const brightness = root.querySelector<HTMLInputElement>('[data-custom-theme-setting="brightness"]')!;
    const advanced = root.querySelector<HTMLDetailsElement>('.custom-theme-advanced')!;
    const color = root.querySelector<HTMLInputElement>('[data-custom-theme-color="controlBg"]')!;
    color.value = '#ffffff';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    advanced.open = true;
    wheel.focus();
    const callsBefore = fetchMock.mock.calls.length;
    wheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    wheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(hue.value).toBe('175');
    expect(brightness.value).toBe('46');
    expect(document.activeElement).toBe(wheel);
    expect(root.querySelector('[data-custom-theme-wheel]')).toBe(wheel);
    expect(advanced.open).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--control-bg')).toBe('#ffffff');
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    root.querySelector<HTMLButtonElement>('[data-custom-theme-save]')!.click();
    const saved = JSON.parse(localStorage.getItem('cmux.theme.custom')!);
    expect(saved.recipe.settings).toEqual({ ...DEFAULT_THEME_GENERATOR_SETTINGS, hue: 175, brightness: 46 });
    hue.value = '270';
    hue.dispatchEvent(new Event('input', { bubbles: true }));
    expect(wheel.getAttribute('aria-label')).toContain('hue 270 degrees');
    root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')!.click();
    expect(root.querySelector('[data-custom-theme-wheel]')?.getAttribute('aria-label')).toContain('hue 175 degrees, brightness 46 percent');
    expect(root.querySelector<HTMLDetailsElement>('.custom-theme-advanced')?.open).toBe(true);
  });

  it('applies a five-color preset, toggles its appearance, and keeps its source colors on save', async () => {
    const presets = THEME_PALETTE_PRESETS as ThemePalettePreset[];
    const fixture: ThemePalettePreset = { id: 'fixture', name: 'Fixture palette', colors: ['#0b132b', '#1c2541', '#3a506b', '#5bc0be', '#ffffff'] };
    presets.push(fixture);
    try {
      const { root } = await openThemeEditor();
      const preset = root.querySelector<HTMLSelectElement>('[data-custom-theme-preset]')!;
      preset.value = fixture.id;
      preset.dispatchEvent(new Event('change', { bubbles: true }));
      const recipe = createThemeRecipeFromPalette(fixture.colors)!;
      expect(root.querySelector<HTMLSelectElement>('[data-custom-theme-harmony]')?.value).toBe('palette');
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe(generateThemePalette(recipe.settings, 'dark', {}, recipe.sourcePalette).accent);
      root.querySelector<HTMLButtonElement>('[data-custom-theme-mode]')!.click();
      expect(document.documentElement.dataset.themeMode).toBe('light');
      expect(root.querySelector('[data-custom-theme-mode]')?.querySelector('use')?.getAttribute('href')).toBe('/icons/theme-mode.svg#sun');
      root.querySelector<HTMLButtonElement>('[data-custom-theme-save]')!.click();
      expect(JSON.parse(localStorage.getItem('cmux.theme.custom')!).recipe.sourcePalette).toEqual(fixture.colors);
      const source = root.querySelector<HTMLSelectElement>('[data-custom-theme-preset]')!;
      source.value = '';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      expect(root.querySelector<HTMLSelectElement>('[data-custom-theme-harmony]')?.value).toBe('analogous');
      root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')!.click();
      expect(root.querySelector<HTMLSelectElement>('[data-custom-theme-preset]')?.value).toBe(fixture.id);
      expect(root.querySelector('[data-custom-theme-mode]')?.getAttribute('aria-pressed')).toBe('false');
    } finally {
      presets.splice(presets.indexOf(fixture), 1);
    }
  });

  it('saves the recipe and appearance, restores both on discard, and previews defaults on reset', async () => {
    const { root } = await openThemeEditor();
    const slider = root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')!;
    slider.value = '42';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const appearance = root.querySelector<HTMLButtonElement>('[data-custom-theme-mode]')!;
    appearance.click();
    expect(appearance.getAttribute('aria-pressed')).toBe('false');
    expect(appearance.querySelector('use')?.getAttribute('href')).toBe('/icons/theme-mode.svg#sun');
    root.querySelector<HTMLButtonElement>('[data-custom-theme-save]')!.click();
    const saved = JSON.parse(localStorage.getItem('cmux.theme.custom')!);
    expect(saved.recipe.settings.hue).toBe(42);
    expect(saved.palette.mode).toBe('light');
    expect(root.querySelector('[data-custom-theme-status]')?.textContent).toBe('Theme saved in this browser.');
    root.querySelector<HTMLButtonElement>('[data-custom-theme-reset]')!.click();
    expect(root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')?.value).toBe(String(DEFAULT_THEME_GENERATOR_SETTINGS.hue));
    root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')!.click();
    expect(root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')?.value).toBe('42');
    expect(root.querySelector('[data-custom-theme-mode]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')?.disabled).toBe(true);
  });

  it('retains the preview and dirty state when atomic theme saving fails', async () => {
    const { root } = await openThemeEditor();
    const slider = root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')!;
    slider.value = '250';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const storageFailure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    root.querySelector<HTMLButtonElement>('[data-custom-theme-save]')!.click();
    expect(root.querySelector('[data-custom-theme-status]')?.getAttribute('role')).toBe('alert');
    expect(root.querySelector('[data-custom-theme-status]')?.textContent).toContain('enable browser storage and retry');
    expect(root.querySelector<HTMLInputElement>('[data-custom-theme-setting="hue"]')?.value).toBe('250');
    expect(root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')?.disabled).toBe(false);
    storageFailure.mockRestore();
    root.querySelector<HTMLButtonElement>('[data-custom-theme-save]')!.click();
    expect(root.querySelector('[data-custom-theme-status]')?.getAttribute('role')).toBe('status');
    expect(root.querySelector<HTMLButtonElement>('[data-custom-theme-discard]')?.disabled).toBe(true);
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

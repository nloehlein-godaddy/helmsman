import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';

let view: DashboardView | null = null;
const payload = () => ({ config: { AGENT_MAX_ATTEMPTS: 1, AGENT_MAX_COST_USD: 5, JIRA_ENABLED: 'true' }, overridden: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function setup(initial: unknown = payload()) {
  let config = initial;
  let nextRead: Promise<Response> | null = null;
  let nextSave: Promise<Response> | null = null;
  const writes: { key: string; value: string }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/config') {
      if (init?.method === 'PUT') {
        const write = JSON.parse(String(init.body)) as { key: string; value: string };
        writes.push(write);
        if (config && typeof config === 'object' && 'config' in config) {
          (config as { config: Record<string, unknown> }).config[write.key] = write.value;
        }
        const response = nextSave;
        nextSave = null;
        return response ?? Response.json({ ok: true });
      }
      const response = nextRead;
      nextRead = null;
      return response ?? Response.json(config);
    }
    if (url.pathname === '/api/context') return Response.json({ repos: ['org/a'], jiraEnabled: true, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return Response.json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/repo/local') return Response.json({ repo: 'org/a', path: null, branches: [], worktrees: [], error: null });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  const field = (key: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`.config-row[data-key="${key}"] .config-input`)!;
  const save = (key: string) => root.querySelector<HTMLButtonElement>(`.config-save[data-key="${key}"]`)!.click();
  return {
    root, field, save, writes, fetcher,
    setConfig: (value: unknown) => { config = value; },
    deferRead: () => { const hold = deferred<Response>(); nextRead = hold.promise; return hold; },
    deferSave: () => { const hold = deferred<Response>(); nextSave = hold.promise; return hold; },
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/config?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Config loading and drafts', () => {
  it.each([null, [], { config: null, overridden: [] }])('shows actionable failure instead of editable defaults for %j', async invalid => {
    const { root, setConfig } = await setup(invalid);
    expect(root.querySelector('.config-input')).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
    setConfig(payload());
    root.querySelector<HTMLButtonElement>('[data-config-retry]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.config-input')).not.toBeNull());
    expect(root.querySelector('[data-config-retry]')).toBeNull();
  });

  it('keeps drafts, focus, and selection after failed refresh and successful retry', async () => {
    const { root, field, setConfig } = await setup();
    field('AGENT_MAX_COST_USD').value = '7';
    field('AGENT_MAX_COST_USD').focus();
    (field('AGENT_MAX_COST_USD') as HTMLInputElement).setSelectionRange(0, 1);
    setConfig(null);
    await view!.refresh();
    expect(field('AGENT_MAX_COST_USD').value).toBe('7');
    expect(document.activeElement).toBe(field('AGENT_MAX_COST_USD'));
    expect((field('AGENT_MAX_COST_USD') as HTMLInputElement).selectionStart).toBe(0);
    expect(root.querySelector('[data-config-retry]')).not.toBeNull();
    setConfig(payload());
    root.querySelector<HTMLButtonElement>('[data-config-retry]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-config-retry]')).toBeNull());
    expect(field('AGENT_MAX_COST_USD').value).toBe('7');
  });

  it('preserves other drafts and edits made while saving a field', async () => {
    const { field, save, deferSave, writes } = await setup();
    const hold = deferSave();
    field('AGENT_MAX_COST_USD').value = '7';
    field('AGENT_MAX_ATTEMPTS').value = '2';
    save('AGENT_MAX_ATTEMPTS');
    field('AGENT_MAX_ATTEMPTS').value = '3';
    hold.resolve(Response.json({ ok: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.config-save[data-key="AGENT_MAX_ATTEMPTS"]')?.disabled).toBe(false));
    expect(writes).toEqual([{ key: 'AGENT_MAX_ATTEMPTS', value: '2' }]);
    expect(field('AGENT_MAX_ATTEMPTS').value).toBe('3');
    expect(field('AGENT_MAX_COST_USD').value).toBe('7');
  });

  it('does not apply a stale read after saving a field', async () => {
    const { field, save, deferRead } = await setup();
    const hold = deferRead();
    const refreshing = view!.refresh();
    field('AGENT_MAX_ATTEMPTS').value = '2';
    save('AGENT_MAX_ATTEMPTS');
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.config-save[data-key="AGENT_MAX_ATTEMPTS"]')?.disabled).toBe(false));
    hold.resolve(Response.json(payload()));
    await refreshing;
    expect(field('AGENT_MAX_ATTEMPTS').value).toBe('2');
    await view!.refresh();
    expect(field('AGENT_MAX_ATTEMPTS').value).toBe('2');
  });

  it('preserves failed save feedback through refresh and allows retry', async () => {
    const { root, field, save, deferSave } = await setup();
    const hold = deferSave();
    field('AGENT_MAX_COST_USD').value = '7';
    save('AGENT_MAX_COST_USD');
    hold.resolve(Response.json(null, { status: 500 }));
    await vi.waitFor(() => expect(field('AGENT_MAX_COST_USD').getAttribute('aria-invalid')).toBe('true'));
    await view!.refresh();
    expect(field('AGENT_MAX_COST_USD').value).toBe('7');
    expect(field('AGENT_MAX_COST_USD').getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('.config-row[data-key="AGENT_MAX_COST_USD"] .config-error')?.textContent).toContain('Save failed');
    save('AGENT_MAX_COST_USD');
    await vi.waitFor(() => expect(field('AGENT_MAX_COST_USD').getAttribute('aria-invalid')).toBeNull());
  });

  it('retains other drafts while legacy Jira settings change without showing an exclusive source toggle', async () => {
    const { root, field, setConfig } = await setup();
    field('AGENT_MAX_COST_USD').value = '7';
    setConfig(payload());
    await view!.refresh();
    expect(field('AGENT_MAX_COST_USD').value).toBe('7');
    expect(root.querySelector('[data-key=JIRA_ENABLED]')).toBeNull();
  });
});

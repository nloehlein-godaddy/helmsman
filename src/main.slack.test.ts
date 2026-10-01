import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { syncBuiltinFrontend } from './plugins/builtin-modules';
import type { CommunicationNotificationsV1 } from './plugins/communication';
import { saveRepoScope } from './logic/prefs';

let view: DashboardView | undefined;
let snapshot: CommunicationNotificationsV1;
let unavailable = false;
const entries = [{ id: 'helmsman.communication', version: '0.2.0', hash: 'a'.repeat(64), enabled: true }];
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear(); window.history.replaceState(null, '', '/config');
  saveRepoScope(null);
  syncBuiltinFrontend(entries, false); unavailable = false;
  snapshot = { version: 1, quality: 'complete', unread: 1, githubHealth: null,
    health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null },
    notifications: [{ kind: 'voyage-completed', id: 'voyage-one', repo: 'org/repo', title: 'Finished change', prNumber: null,
      prUrl: '', sourceUrl: '/runs?run=run-one', author: 'Helmsman', channelName: 'Helmsman voyages', status: 'succeeded',
      runId: 'run-one', createdAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-20T12:00:00Z', readAt: null, error: null }] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/context') return Response.json({ repos: ['org/repo', 'org/other'], jiraBaseUrl: null });
    if (url.pathname === '/api/config') return Response.json({ config: {}, overridden: [] });
    if (url.pathname === '/api/agents') return Response.json({ runs: [], autoClaim: [], caps: {} });
    if (url.pathname === '/api/communication/notifications') {
      expect(new Headers(init?.headers).get('x-helmsman-contribution')).toBe('helmsman.communication/header');
      if (unavailable) return new Response('', { status: 503 });
      const repo = url.searchParams.get('repo');
      const notifications = snapshot.notifications.filter(item => !repo || item.repo === repo);
      return Response.json({ ...snapshot, notifications, unread: notifications.filter(item => item.readAt === null).length });
    }
    if (url.pathname === '/api/communication/notifications/voyage-one/read') {
      expect(JSON.parse(String(init?.body)).repo).toBe('org/repo');
      const readAt = new Date().toISOString();
      snapshot = { ...snapshot, notifications: snapshot.notifications.map(item => ({ ...item, readAt })), unread: 0 };
      return Response.json({ version: 1, id: 'voyage-one', readAt });
    }
    return new Response('', { status: 503 });
  }));
});
afterEach(() => { view?.destroy(); view = undefined; syncBuiltinFrontend([], false); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); });
const start = async () => {
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start();
  await vi.waitFor(() => expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('1 unread'));
};
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)?.click();

describe('authored notification header', () => {
  it('preserves completed voyages, read state and keyboard control across page navigation', async () => {
    await start(); click('[data-slack-toggle]');
    expect(document.querySelector('.slack-voyage-title')?.textContent).toBe('Finished change');
    click('[data-slack-read]');
    await vi.waitFor(() => expect(document.querySelector('[data-slack-read]')).toBeNull());
    const original = document.querySelector('[data-slack-toggle]');
    click('[data-view="prs"]');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/prs'));
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-controls')).toBe(original?.getAttribute('aria-controls'));
    click('[data-slack-toggle]');
    document.querySelector('[data-slack-toggle]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector<HTMLElement>('.slack-popover')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-slack-toggle]'));
    expect(original?.getAttribute('aria-label')).toContain('0 unread');
  });
  it('uses the header scope for reads and preserves it in run links', async () => {
    await start(); click('[data-slack-toggle]');
    const select = document.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/repo'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>('.slack-notification .app-link');
      expect(new URL(link?.href ?? '', window.location.origin).searchParams.get('repo')).toBe('org/repo');
    });
    expect(new URL(document.querySelector<HTMLAnchorElement>('.slack-notification .app-link')!.href).searchParams.get('runRepo')).toBe('org/repo');
    select.value = 'org/other'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('.slack-notification')).toHaveLength(0));
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/other');
  });
  it('retains evidence on outage and removes the header when its plugin is disabled', async () => {
    await start(); click('[data-slack-toggle]'); unavailable = true;
    await view?.refresh();
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(1);
    expect(document.querySelector('.slack-action-error')?.textContent).toContain('Notifications unavailable');
    syncBuiltinFrontend(entries.map(entry => ({ ...entry, enabled: false })), false);
    await vi.waitFor(() => expect(document.querySelector('[data-slack-toggle]')).toBeNull());
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/slack'))).toBe(false);
  });
});

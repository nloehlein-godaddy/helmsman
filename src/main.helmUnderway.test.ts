import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { appPages, HELM_PAGE_ID, HELM_PAGE_SLOT } from './plugins/builtins';
import { appPageModules, syncBuiltinFrontend } from './plugins/builtin-modules';
import { loadPluginCatalog } from './plugins/runtime';

let view: DashboardView | undefined;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/helm?repo=org/a');
  syncBuiltinFrontend([], false);
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => { view?.destroy(); view = undefined; vi.unstubAllGlobals(); localStorage.clear(); });

describe('Helm plugin cutover', () => {
  it.each(['missing', 'failed'] as const)('keeps Helm unavailable when the catalog is %s without legacy dashboard reads or launch controls', async status => {
    const requests: string[] = [];
    const json = (data: unknown) => new Response(JSON.stringify(data));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      requests.push(path);
      if (path === '/api/context') return json({ repos: ['org/a'], jiraBaseUrl: null });
      if (path === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1 } });
      if (path === '/api/config') return json({ config: {}, overridden: [] });
      return new Response(null, { status: 503 });
    }));
    const runtime = status === 'failed' ? await loadPluginCatalog(appPages, appPageModules, { applyBuiltins: syncBuiltinFrontend }) : null;
    try {
      expect(appPages.resolvePath('/helm')).toMatchObject({ slotId: HELM_PAGE_SLOT, contributionId: HELM_PAGE_ID, page: null });
      const root = document.querySelector<HTMLElement>('#app')!;
      view = new DashboardView(root);
      await view.start();
      expect(root.querySelector('[role="status"]')?.textContent).toContain('unavailable');
      expect(root.querySelector('[data-recovery-link]')).not.toBeNull();
      expect(root.querySelector('.newrun-launch, .launch-btn, .helm-rack')).toBeNull();
      expect(requests).not.toContain('/api/dashboard');
      expect(requests).not.toContain('/api/pr/open');
      expect(requests).not.toContain('/api/agents/launch');
    } finally { runtime?.dispose(); }
  });
});

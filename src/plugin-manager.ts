import { apiFetch } from './data/api-client';
import './plugin-manager.css';
import { appPages } from './plugins/builtins';
import { routeHref } from './logic/routes';

type Expected = { hash: string; revision: number; desiredEnabled: boolean };
type Plugin = { id: string; name: string; version: string; kind: 'builtin' | 'external'; hash: string; desiredEnabled: boolean; health: string; state: string; revision: number; obligationsOnly: boolean };
type Preview = { id: string; name: string; version: string; hash: string; kind: 'external'; expected: Expected | null; description?: string; permissions?: string[] };
type ArchiveDraft = { archiveBase64: string; fileName: string; preview: Preview; targetId: string | null; trusted: boolean };

const endpoint = '/api/plugins/manage';
const icon = (path: string) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path); svg.append(shape); return svg;
};
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const expectedOf = (value: unknown): Expected | null => isRecord(value) && typeof value.hash === 'string' && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && typeof value.desiredEnabled === 'boolean'
  ? { hash: value.hash, revision: value.revision as number, desiredEnabled: value.desiredEnabled } : null;
const pluginOf = (value: unknown): Plugin | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.version !== 'string' || (value.kind !== 'builtin' && value.kind !== 'external') || typeof value.hash !== 'string' || typeof value.desiredEnabled !== 'boolean' || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)) return null;
  return { id: value.id, name: value.name, version: value.version, kind: value.kind, hash: value.hash, desiredEnabled: value.desiredEnabled, health: typeof value.health === 'string' ? value.health : 'Unknown', state: typeof value.state === 'string' ? value.state : 'Unknown', revision: value.revision as number, obligationsOnly: value.obligationsOnly === true };
};
const previewOf = (value: unknown): Preview | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.hash !== 'string' || value.kind !== 'external' || (value.expected !== null && !expectedOf(value.expected))) return null;
  return { id: value.id, name: value.name, version: value.version, hash: value.hash, kind: 'external', expected: expectedOf(value.expected), description: typeof value.description === 'string' ? value.description : undefined, permissions: Array.isArray(value.permissions) ? value.permissions.filter((item): item is string => typeof item === 'string') : undefined };
};
const archiveBase64 = async (file: File): Promise<string> => {
  if (file.size > 15_728_640) throw new Error('The .hmp archive exceeds the 15 MiB upload limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
};

export function mountPluginManager(container: HTMLElement, options: { repo: string | null }): { dispose(): void; updateScope(repo: string | null): void } {
  let repo = options.repo;
  let plugins: Plugin[] | null = null;
  let query = '';
  let expandedId: string | null = null;
  let draft: ArchiveDraft | null = null;
  let error = '';
  let notice = '';
  let busy = false;
  let readOnly = false;
  let disposed = false;
  let requestId = 0;
  const requests = new Set<AbortController>();
  const fileInput = element('input'); fileInput.type = 'file'; fileInput.accept = '.hmp'; fileInput.hidden = true; fileInput.setAttribute('aria-label', 'Choose .hmp plugin archive');
  let uploadTarget: string | null = null;

  async function request(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController(); requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await apiFetch(endpoint, body ? { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal } : { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(isRecord(data) && typeof data.error === 'string' ? data.error : `Plugin manager request failed (${response.status}).`);
      if (!isRecord(data) || data.version !== 1) throw new Error('Plugin manager returned an invalid response. Refresh and try again.');
      return data;
    } catch (cause) {
      if (controller.signal.aborted && !disposed) throw new Error('Plugin manager request timed out. Refresh and try again.');
      throw cause;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  function setPlugins(data: Record<string, unknown>) {
    if (!Array.isArray(data.plugins)) throw new Error('Plugin list is unavailable. Refresh and try again.');
    const next = data.plugins.map(pluginOf);
    if (next.some(item => !item)) throw new Error('Plugin list contains invalid data. Refresh and try again.');
    plugins = next as Plugin[];
    readOnly = data.readOnly === true;
    if (data.restartRequired === true) notice ||= 'Plugin changes are saved. Restart Helmsman to apply them.';
    else if (data.restartRequired === false) notice = '';
  }
  function draftMatchesCurrent(value: ArchiveDraft): boolean {
    const row = plugins?.find(plugin => plugin.id === value.preview.id);
    const expected = value.preview.expected;
    return expected ? Boolean(row && row.hash === expected.hash && row.revision === expected.revision && row.desiredEnabled === expected.desiredEnabled) : !row;
  }
  async function refresh() {
    if (busy || disposed) return;
    const sequence = ++requestId; busy = true; error = ''; render();
    try { const data = await request(); if (disposed || sequence !== requestId) return; setPlugins(data); if (draft && !draftMatchesCurrent(draft)) { draft = null; error = 'Plugin state changed. Inspect the archive again before continuing.'; } }
    catch (cause) { if (!disposed && sequence === requestId) error = cause instanceof Error ? cause.message : 'Plugins are unavailable. Refresh and try again.'; }
    finally { if (!disposed && sequence === requestId) { busy = false; render(); } }
  }
  async function mutate(action: 'enable' | 'disable' | 'uninstall', plugin: Plugin, trustConfirmed = false) {
    if (busy || disposed || readOnly) return;
    busy = true; error = ''; notice = ''; render();
    try {
      const data = await request({ action, id: plugin.id, expected: { hash: plugin.hash, revision: plugin.revision, desiredEnabled: plugin.desiredEnabled }, ...(trustConfirmed ? { trustConfirmed: true } : {}) });
      if (disposed) return;
      setPlugins(data);
      notice = `${plugin.name}: ${action === 'uninstall' ? 'removal' : action === 'enable' ? 'enablement' : 'disablement'} saved. Restart Helmsman to apply the change.`;
      expandedId = action === 'uninstall' ? null : plugin.id;
    } catch (cause) { if (!disposed) error = `${cause instanceof Error ? cause.message : 'Plugin change failed.'} Refresh the list before retrying.`; }
    finally { if (!disposed) { busy = false; render(); } }
  }
  async function inspect(file: File, targetId: string | null) {
    if (busy || disposed) return;
    busy = true; error = ''; notice = ''; draft = null; render();
    try {
      if (!file.name.toLowerCase().endsWith('.hmp')) throw new Error('Choose a .hmp plugin archive.');
      const encoded = await archiveBase64(file);
      if (disposed) return;
      const data = await request({ action: 'inspect', archiveBase64: encoded });
      if (disposed) return;
      const preview = previewOf(data.preview);
      if (!preview) throw new Error('The archive preview is invalid. Choose another archive.');
      if (targetId && preview.id !== targetId) throw new Error(`This archive is for ${preview.id}; choose an archive for ${targetId}.`);
      if (targetId && !preview.expected) throw new Error(`No installed plugin matches ${targetId}. Refresh the list before updating.`);
      if (targetId && preview.expected?.desiredEnabled) throw new Error(`Disable ${targetId} and restart Helmsman before updating it.`);
      if (!targetId && preview.expected) throw new Error(`${preview.id} is already installed. Use Update on its row.`);
      draft = { archiveBase64: encoded, fileName: file.name, preview, targetId, trusted: false };
    } catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : 'Archive inspection failed. Choose another archive.'; }
    finally { if (!disposed) { busy = false; render(); } }
  }
  async function install() {
    if (busy || disposed || readOnly || !draft?.trusted) return;
    const current = draft;
    if (current.targetId && current.preview.id !== current.targetId) return;
    if (!draftMatchesCurrent(current)) { draft = null; error = 'Plugin state changed. Inspect the archive again before continuing.'; render(); return; }
    busy = true; error = ''; notice = ''; render();
    try {
      const data = await request({ action: 'install', archiveBase64: current.archiveBase64, confirmedHash: current.preview.hash, expected: current.preview.expected, trustConfirmed: true });
      if (disposed) return;
      setPlugins(data); draft = null; notice = `${current.preview.name} ${current.targetId ? 'update' : 'installation'} saved. Restart Helmsman to apply the change.`;
    } catch (cause) { if (!disposed) { error = `${cause instanceof Error ? cause.message : 'Installation failed.'} Inspect the archive again before retrying.`; draft = null; } }
    finally { if (!disposed) { busy = false; render(); } }
  }
  fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void inspect(file, uploadTarget); fileInput.value = ''; });
  function chooseArchive(targetId: string | null) { if (busy || readOnly) return; uploadTarget = targetId; fileInput.click(); }
  function action(label: string, run: () => void, className = '') {
    const control = element('button', label); control.type = 'button'; control.className = className; control.disabled = busy; control.addEventListener('click', run); return control;
  }
  function render() {
    if (disposed) return;
    const focused = container.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    const selection = document.activeElement instanceof HTMLInputElement && focused === 'search' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const root = element('section'); root.className = 'plugin-manager'; root.setAttribute('aria-label', 'Plugins');
    const header = element('header'); header.className = 'plugin-manager-header';
    const heading = element('div'); heading.append(element('h1', 'Plugins'), element('p', 'Manage installed plugins and inspect archives before trusting them.'));
    const headerActions = element('div'); headerActions.className = 'plugin-manager-header-actions';
    const refreshButton = action('', () => { void refresh(); }, 'plugin-manager-icon'); refreshButton.setAttribute('aria-label', 'Refresh plugins'); refreshButton.title = 'Refresh plugins'; refreshButton.dataset.focusKey = 'refresh'; refreshButton.append(icon('M20 11a8 8 0 0 0-14.5-4.5L3 9m0-6v6h6 M4 13a8 8 0 0 0 14.5 4.5L21 15m0 6v-6h-6'));
    const installButton = action('Install plugin', () => chooseArchive(null), 'plugin-manager-primary'); installButton.dataset.focusKey = 'install'; installButton.disabled ||= readOnly;
    headerActions.append(refreshButton, installButton); header.append(heading, headerActions); root.append(header);
    const intro = element('p'); intro.className = 'plugin-manager-hint'; intro.append('Bundled plugins update with Helmsman. External plugin changes take effect after a restart. For pinned Jira source recovery, use ');
    const sourceLink = element('a', 'Source settings'); sourceLink.className = 'plugin-manager-source-link app-link'; sourceLink.href = `/source-settings${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`; intro.append(sourceLink, '.'); root.append(intro);
    if (readOnly) { const status = element('p', 'Safe start: plugin changes are read-only. Inspect recovery information or restart normally before making changes.'); status.className = 'plugin-manager-status'; status.setAttribute('role', 'status'); root.append(status); }
    if (notice) { const status = element('p', notice); status.className = 'plugin-manager-status'; status.setAttribute('role', 'status'); root.append(status); }
    if (error) { const alert = element('p', error); alert.className = 'plugin-manager-error'; alert.setAttribute('role', 'alert'); root.append(alert); }
    if (draft) {
      const preview = element('section'); preview.className = 'plugin-manager-preview'; preview.setAttribute('aria-label', 'Archive preview');
      preview.append(element('h2', draft.targetId ? 'Review plugin update' : 'Review plugin installation'));
      preview.append(element('p', `${draft.preview.name} · ${draft.preview.id} · version ${draft.preview.version}`));
      preview.append(element('p', `Archive: ${draft.fileName}`), element('p', `SHA-256: ${draft.preview.hash}`));
      if (draft.preview.description) preview.append(element('p', draft.preview.description));
      if (draft.preview.permissions?.length) preview.append(element('p', `Declared permissions: ${draft.preview.permissions.join(', ')}`));
      const trustLabel = element('label'); trustLabel.className = 'plugin-manager-trust';
      const trust = element('input'); trust.type = 'checkbox'; trust.checked = draft.trusted; trust.disabled = busy; trust.dataset.focusKey = 'trust'; trust.addEventListener('change', () => { if (draft) { draft.trusted = trust.checked; render(); } });
      trustLabel.append(trust, document.createTextNode('I trust this archive and its plugin code.')); preview.append(trustLabel);
      const previewActions = element('div'); previewActions.className = 'plugin-manager-actions';
      const confirm = action(draft.targetId ? 'Update plugin' : 'Install plugin', () => { void install(); }, 'plugin-manager-primary'); confirm.disabled ||= !draft.trusted || readOnly; confirm.dataset.focusKey = 'confirm';
      previewActions.append(confirm, action('Cancel', () => { draft = null; render(); })); preview.append(previewActions); root.append(preview);
    }
    const filter = element('div'); filter.className = 'plugin-manager-filter'; const searchLabel = element('label', 'Search plugins'); searchLabel.htmlFor = 'plugin-manager-search';
    const search = element('input'); search.id = 'plugin-manager-search'; search.type = 'search'; search.value = query; search.placeholder = 'Name or ID'; search.dataset.focusKey = 'search'; search.addEventListener('input', () => { query = search.value; render(); }); filter.append(searchLabel, search); root.append(filter);
    const list = element('div'); list.className = 'plugin-manager-list';
    if (!plugins) { const status = element('p', busy ? 'Loading plugins…' : 'Plugin list unavailable. Refresh to retry.'); status.setAttribute('role', 'status'); list.append(status); }
    else {
      const matches = plugins.filter(plugin => `${plugin.name} ${plugin.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      const count = element('p', `${matches.length} ${matches.length === 1 ? 'plugin' : 'plugins'}`); count.className = 'plugin-manager-count'; list.append(count);
      if (!matches.length) { const empty = element('p', plugins.length ? 'No plugins match your search.' : 'No plugins are installed.'); empty.setAttribute('role', 'status'); list.append(empty); }
      for (const plugin of matches) {
        const row = element('article'); row.className = 'plugin-manager-row'; row.dataset.pluginId = plugin.id;
        const summary = element('div'); summary.className = 'plugin-manager-summary';
        const identity = element('div'); identity.className = 'plugin-manager-identity'; identity.append(element('strong', plugin.name), element('span', plugin.id));
        const meta = element('div'); meta.className = 'plugin-manager-meta'; meta.append(element('span', `v${plugin.version}`), element('span', plugin.kind === 'builtin' ? 'Bundled · updates with Helmsman' : 'External'), element('span', `Configured: ${plugin.desiredEnabled ? 'Enabled' : 'Disabled'}`));
        if (plugin.obligationsOnly) meta.append(element('span', 'Retained work only'));
        const details = action(expandedId === plugin.id ? 'Hide details' : 'Details', () => { expandedId = expandedId === plugin.id ? null : plugin.id; render(); }); details.setAttribute('aria-expanded', String(expandedId === plugin.id)); details.dataset.focusKey = `details:${plugin.id}`;
        summary.append(identity, meta, details); row.append(summary);
        const pages = appPages.listPages().filter(page => page.pluginId === plugin.id && page.navigation !== false);
        if (pages.length) {
          const links = element('nav'); links.className = 'plugin-manager-page-links'; links.setAttribute('aria-label', `${plugin.name} pages`);
          for (const page of pages) {
            const link = element('a', `Open page: ${page.title}`); link.className = 'app-link'; link.dataset.pluginPage = page.contributionId; link.dataset.focusKey = `page:${page.contributionId}`;
            link.href = routeHref({ view: 'plugin', pluginPage: page.contributionId, repo }); links.append(link);
          }
          row.append(links);
        }
        if (expandedId === plugin.id) {
          const body = element('div'); body.className = 'plugin-manager-detail';
          body.append(element('p', `State: ${plugin.state} · Health: ${plugin.health}`), element('p', `Artifact: ${plugin.hash}`));
          const actions = element('div'); actions.className = 'plugin-manager-actions';
          if (plugin.desiredEnabled) {
            const disable = action('Disable', () => { void mutate('disable', plugin); }); disable.dataset.focusKey = `disable:${plugin.id}`; disable.disabled ||= readOnly; actions.append(disable);
            if (plugin.kind === 'external') actions.append(element('span', 'Disable before updating or removing.'));
          } else {
            const trust = element('label'); trust.className = 'plugin-manager-inline-trust';
            const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.disabled = readOnly; checkbox.dataset.focusKey = `enable-trust:${plugin.id}`; checkbox.addEventListener('change', () => { const enable = actions.querySelector<HTMLButtonElement>('[data-enable]'); if (enable) enable.disabled = busy || readOnly || !checkbox.checked; });
            trust.append(checkbox, document.createTextNode(plugin.kind === 'builtin' ? 'I want Helmsman to enable this bundled plugin.' : 'I trust this installed plugin’s code.')); actions.append(trust);
            const enable = action('Enable', () => { if (checkbox.checked) void mutate('enable', plugin, true); }); enable.dataset.enable = ''; enable.dataset.focusKey = `enable:${plugin.id}`; enable.disabled = true; actions.append(enable);
            if (plugin.kind === 'external') {
              const update = action('Update from .hmp', () => chooseArchive(plugin.id)); update.dataset.focusKey = `update:${plugin.id}`; update.disabled ||= readOnly; actions.append(update);
              const remove = action('Remove', () => { void mutate('uninstall', plugin); }); remove.dataset.focusKey = `remove:${plugin.id}`; remove.disabled ||= readOnly; actions.append(remove);
            }
          }
          if (plugin.kind === 'builtin') body.append(element('p', 'Bundled plugin code updates with the Helmsman application.'));
          body.append(actions);
          row.append(body);
        }
        list.append(row);
      }
    }
    root.append(list, fileInput); container.replaceChildren(root);
    if (focused) {
      const controls = [...root.querySelectorAll<HTMLElement>('[data-focus-key]')];
      const replacement = controls.find(node => node.dataset.focusKey === focused && !node.matches(':disabled'))
        ?? controls.find(node => node.dataset.focusKey === `details:${expandedId}` && !node.matches(':disabled'))
        ?? controls.find(node => node.dataset.focusKey === 'search');
      if (replacement && !replacement.closest('[hidden]')) { replacement.focus({ preventScroll: true }); if (selection && replacement instanceof HTMLInputElement && selection[0] !== null && selection[1] !== null) replacement.setSelectionRange(selection[0], selection[1]); }
    }
  }
  const unsubscribePages = appPages.subscribe(render);
  render(); void refresh();
  return { dispose() { disposed = true; unsubscribePages(); requestId++; for (const controller of requests) controller.abort(); container.replaceChildren(); }, updateScope(nextRepo) { if (repo === nextRepo) return; repo = nextRepo; const link = container.querySelector<HTMLAnchorElement>('.plugin-manager-source-link'); if (link) link.href = `/source-settings${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`; for (const page of container.querySelectorAll<HTMLAnchorElement>('[data-plugin-page]')) page.href = routeHref({ view: 'plugin', pluginPage: page.dataset.pluginPage, repo }); } };
}

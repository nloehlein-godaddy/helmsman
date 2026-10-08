import type { CompositionLayoutV1, ManagedPanelInstanceV1, PluginPageModule } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';


const pageControlsStyles = `
[data-composition-page] > .composition-page-header { display:flex; align-items:center; justify-content:space-between; gap:16px; min-width:0; margin-bottom:16px; }
[data-composition-page] > .composition-page-header h1 { margin:0; min-width:0; overflow-wrap:anywhere; }
[data-composition-page] .composition-page-actions { display:flex; align-items:center; flex-shrink:0; gap:8px; margin:0; }
[data-composition-page] .composition-icon-button { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; min-width:36px; padding:8px; color:var(--text); background:var(--panel-hi); border:1px solid var(--line-strong); border-radius:6px; }
[data-composition-page] .composition-icon-button svg { width:18px; height:18px; pointer-events:none; }
[data-composition-page] .composition-icon-button:hover:not(:disabled) { color:var(--accent-text,var(--accent)); }
[data-composition-page] .composition-page-editor { padding:16px; margin-bottom:16px; border:1px solid var(--line); border-radius:6px; background:var(--panel); }
[data-composition-page] .composition-page-editor[hidden] { display:none; }
[data-composition-page] .composition-page-editor > p { margin:0 0 12px; color:var(--text-dim); }
[data-composition-page] .composition-editor-add, [data-composition-page] .composition-panel-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 0; }
[data-composition-page] .composition-editor-add select { max-width:100%; min-width:0; }
[data-composition-page] .composition-panel-row + .composition-panel-row { border-top:1px solid var(--line-faint); }
[data-composition-page] .composition-panel-row > strong { flex:1 1 180px; overflow-wrap:anywhere; }
[data-composition-page] .composition-panel-tabs { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
[data-composition-page] .composition-panel-tabs button[aria-pressed=true] { color:var(--on-accent); background:var(--accent); }
[data-composition-page] :is(.composition-page-header,.composition-page-editor,.composition-panel-tabs) :is(button,select):focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media(any-pointer:coarse) { [data-composition-page] .composition-icon-button { width:44px; height:44px; min-width:44px; } }
`;

const page: PluginPageModule = { mount(container, context) {
  const composition = context.composition;
  if (composition?.version !== 1 || composition.compositionId !== 'helmsman/bugs-page') throw new Error('Bugs requires its composition service');
  let state = context.state;
  let editing = false;
  const editorId = `page-editor-${crypto.randomUUID()}`;
  let layout: CompositionLayoutV1 | null = null;
  let disposed = false; let generation = 0; let saving = false; let error = '';
  const mounted = new Map<string, { node: HTMLElement; handle: ManagedPanelInstanceV1 | null; retired: boolean; active: boolean; contribution: string }>();
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
  function button(label: string, action: () => void) { const value = node('button', label); value.type = 'button'; value.dataset.pageAction = label; value.disabled = saving; value.addEventListener('click', action); return value; }
  function iconButton(label: string, path: string, action: () => void) {
    const value = button(label, action); value.className = 'composition-icon-button'; value.setAttribute('aria-label', label); value.title = label;
    value.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`; return value;
  }
  function removePanel(id: string) {
    if (!editing || !layout || saving) return;
    void save({ ...layout, instances: layout.instances.filter(instance => instance.instanceId !== id), columns: layout.columns.map(column => column.flatMap(stack => {
      const instances = stack.instances.filter(instance => instance !== id);
      const visible = instances.find(candidate => layout?.instances.some(instance => instance.instanceId === candidate && !instance.hidden));
      return instances.length ? [{ ...stack, instances, activeInstanceId: stack.activeInstanceId === id ? visible ?? instances[0]! : stack.activeInstanceId }] : [];
    })) });
  }
  async function read() {
    const current = ++generation;
    try {
      const next = await composition!.readLayout();
      if (disposed || current !== generation) return;
      if (!layout || next.revision >= layout.revision) layout = next;
      error = ''; draw();
    } catch { if (!disposed && current === generation) { error = 'Your saved Bugs panels are unavailable. Refresh to retry.'; draw(); } }
  }
  async function save(next: CompositionLayoutV1) {
    if (disposed || saving || !layout) return;
    const expected = layout.revision; saving = true; draw();
    try {
      const saved = await composition!.updateLayout(next, expected);
      if (!disposed && (!layout || saved.revision >= layout.revision)) layout = saved;
      error = '';
    } catch { if (!disposed) { await read(); error = 'The layout changed or could not be saved. Review it and retry.'; } }
    finally { saving = false; draw(); }
  }
  function draw() {
    if (disposed) return;
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
    const root = node('div'); root.className = 'plugin-bugs'; root.dataset.compositionPage = ''; root.append(node('style', styles), node('style', pageControlsStyles));
    const header = node('div'); header.className = 'composition-page-header'; header.append(node('h1', 'Bugs'));
    const toolbar = node('div'); toolbar.className = 'composition-page-actions';
    const refreshButton = iconButton('Refresh page', '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>', () => { void refresh(); });
    const editButton = editing ? button('Done', () => { editing = false; draw(); }) : iconButton('Edit page', '<path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4Z"/>', () => { editing = true; draw(); });
    editButton.classList.add('composition-page-edit'); editButton.setAttribute('aria-label', editing ? 'Done editing page' : 'Edit page'); editButton.title = editing ? 'Done editing page' : 'Edit page'; editButton.dataset.pageAction = 'edit-page'; editButton.disabled = false; editButton.setAttribute('aria-pressed', String(editing)); editButton.setAttribute('aria-controls', editorId);
    toolbar.append(refreshButton, editButton); header.append(toolbar); root.append(header);
    const editor = node('div'); editor.className = 'composition-page-editor'; editor.id = editorId; editor.hidden = !editing; editor.setAttribute('role', 'region'); editor.setAttribute('aria-label', 'Page customization');
    editor.append(node('p', 'Add, hide or remove panels here. Changes are saved automatically. Removing a panel does not stop running work.'));
    const addControls = node('div'); addControls.className = 'composition-editor-add'; editor.append(addControls);
    const options = node('select'); options.setAttribute('aria-label', 'Bugs panel implementation');
    for (const candidate of composition!.discover()) { const option = node('option', candidate.title); option.value = candidate.contributionId; options.append(option); }
    options.disabled = !editing || saving; options.dataset.pageAction = 'implementation';
    addControls.append(options, button('Add panel', () => {
      if (!editing || !layout || !options.value) return;
      const id = crypto.randomUUID();
      void save({ ...layout, instances: [...layout.instances, { instanceId: id, contributionId: options.value, scope: { kind: 'inherit' }, state: {}, hidden: false }],
        columns: [...layout.columns, ...(layout.columns.length ? [] : [[]])].map((column, index) => index ? column : [...column, { instances: [id], activeInstanceId: id, collapsed: false }]) });
    }));
    const addButton = addControls.querySelector('button'); if (addButton) addButton.disabled ||= !editing || !options.options.length;
    root.append(editor);
    if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); root.append(message); }
    if (!layout) root.append(node('p', 'Loading Bugs panels…'));
    else {
      if (!layout.instances.some(instance => !instance.hidden)) root.append(node('p', 'No visible panels. Choose Edit page to add or show a panel.'));
      for (const [id, child] of mounted) if (!layout.instances.some(item => item.instanceId === id && item.contributionId === child.contribution)) {
        child.retired = true; child.handle?.dispose(); mounted.delete(id);
      }
      for (const stack of layout.columns.flat()) {
        const section = node('section');
        const visible = stack.instances.filter(id => layout?.instances.some(instance => instance.instanceId === id && !instance.hidden));
        if (visible.length && (visible.length > 1 || stack.collapsed || !visible.includes(stack.activeInstanceId))) {
          const tabs = node('div'); tabs.className = 'composition-panel-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Panels');
          for (const id of visible) {
            const instance = layout.instances.find(value => value.instanceId === id); if (!instance) continue;
            const title = composition!.discover().find(value => value.contributionId === instance.contributionId)?.title ?? instance.contributionId;
            const tab = button(stack.collapsed ? `Expand ${title}` : title, () => {
              if (layout) void save({ ...layout, columns: layout.columns.map(column => column.map(value => value.instances.includes(id) ? { ...value, activeInstanceId: id, collapsed: false } : value)) });
            });
            tab.dataset.pageAction = `${id}:tab`; tab.setAttribute('aria-pressed', String(!stack.collapsed && stack.activeInstanceId === id)); tabs.append(tab);
          }
          section.append(tabs);
        }
        for (const id of stack.instances) {
          const instance = layout.instances.find(value => value.instanceId === id); if (!instance) continue;
          const title = composition!.discover().find(value => value.contributionId === instance.contributionId)?.title ?? instance.contributionId;
          const row = node('div'); row.className = 'composition-panel-row'; row.dataset.instanceId = id; row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${title} · ${id}`);
          const copies = layout.instances.filter(value => value.contributionId === instance.contributionId);
          row.append(node('strong', `${title}${copies.length > 1 ? ` (${copies.findIndex(value => value.instanceId === id) + 1})` : ''}`));
          const toggle = button(instance.hidden ? 'Show panel' : 'Hide panel', () => {
            if (!editing || !layout) return;
            const instances = layout.instances.map(value => value.instanceId === id ? { ...value, hidden: !value.hidden } : value);
            void save({ ...layout, instances, columns: layout.columns.map(column => column.map(value => {
              const visible = value.instances.find(candidate => instances.some(item => item.instanceId === candidate && !item.hidden));
              if (instance.hidden && value.instances.includes(id)) return { ...value, activeInstanceId: id, collapsed: false };
              return value.activeInstanceId === id && visible ? { ...value, activeInstanceId: visible } : value;
            })) });
          });
          toggle.dataset.pageAction = `${id}:visibility`; toggle.disabled ||= !editing; toggle.setAttribute('aria-label', `${instance.hidden ? 'Show' : 'Hide'} ${title}`);
          const remove = button('Remove panel', () => removePanel(id)); remove.dataset.pageAction = `${id}:remove`; remove.disabled ||= !editing; remove.setAttribute('aria-label', `Remove ${title}`);
          row.append(toggle, remove); editor.append(row);
          let child = mounted.get(id);
          if (!child) {
            child = { node: node('div'), handle: null, retired: false, active: false, contribution: instance.contributionId }; mounted.set(id, child);
            const pending = child;
            void Promise.resolve().then(() => disposed || pending.retired ? null : composition!.mount(id, pending.node)).then(handle => {
              if (!handle) return;
              if (disposed || pending.retired) handle.dispose(); else { pending.handle = handle; handle.setActive(pending.active); }
            }).catch(() => { if (!disposed && !pending.retired) { pending.node.textContent = 'Panel unavailable. Its saved settings are kept.'; pending.node.setAttribute('role', 'status'); } });
          }
          child.active = state.visible && !instance.hidden && !stack.collapsed && stack.activeInstanceId === id;
          child.node.hidden = !child.active; child.handle?.setActive(child.active); section.append(child.node);
        }
        root.append(section);
      }
    }
    container.replaceChildren(root);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    else if (focused?.dataset.pageAction) {
      const replacement = [...root.querySelectorAll<HTMLElement>('[data-page-action]')].find(value => value.dataset.pageAction === focused.dataset.pageAction);
      (replacement && !(replacement instanceof HTMLButtonElement && replacement.disabled) && !replacement.closest('[hidden]') ? replacement : editButton).focus({ preventScroll: true });
    }
  }
  async function refresh() { await read(); await Promise.all([...mounted.values()].filter(value => value.active).map(value => value.handle?.refresh())); }
  const unsubscribe = composition.subscribe(() => { void read(); });
  function dispose() {
    if (disposed) return; disposed = true; ++generation; unsubscribe(); context.signal.removeEventListener('abort', dispose);
    for (const child of mounted.values()) { child.retired = true; child.handle?.dispose(); } mounted.clear();
  }
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose(); else void read();
  return { update(next) { if (!disposed) { state = next; draw(); } }, refresh, dispose };
} };
export default page;

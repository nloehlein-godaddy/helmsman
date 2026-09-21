import type { CompositionLayoutV1, ManagedPanelInstanceV1, PluginPageModule } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';

const page: PluginPageModule = { mount(container, context) {
  const composition = context.composition;
  if (composition?.version !== 1 || composition.compositionId !== 'helmsman/source-settings-page') throw new Error('Source settings requires its composition service');
  let state = context.state;
  let layout: CompositionLayoutV1 | null = null;
  let disposed = false; let generation = 0; let saving = false; let error = '';
  const mounted = new Map<string, { node: HTMLElement; handle: ManagedPanelInstanceV1 | null; retired: boolean; active: boolean; contribution: string }>();
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
  function button(label: string, action: () => void) { const value = node('button', label); value.type = 'button'; value.disabled = saving; value.addEventListener('click', action); return value; }
  async function read() {
    const current = ++generation;
    try {
      const next = await composition!.readLayout();
      if (disposed || current !== generation) return;
      if (!layout || next.revision >= layout.revision) layout = next;
      error = ''; draw();
    } catch { if (!disposed && current === generation) { error = 'Your saved source settings panels are unavailable. Refresh to retry.'; draw(); } }
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
    const root = node('div'); root.className = 'plugin-source-settings'; root.append(node('style', styles), node('h1', 'Source settings'));
    const toolbar = node('div'); toolbar.className = 'source-settings-tools'; toolbar.append(button('Refresh', () => { void refresh(); }));
    const options = node('select'); options.setAttribute('aria-label', 'source settings panel implementation');
    for (const candidate of composition!.discover()) { const option = node('option', candidate.title); option.value = candidate.contributionId; options.append(option); }
    toolbar.append(options, button('Add panel', () => {
      if (!layout || !options.value) return;
      const id = crypto.randomUUID();
      void save({ ...layout, instances: [...layout.instances, { instanceId: id, contributionId: options.value, scope: { kind: 'inherit' }, state: {}, hidden: false }],
        columns: [...layout.columns, ...(layout.columns.length ? [] : [[]])].map((column, index) => index ? column : [...column, { instances: [id], activeInstanceId: id, collapsed: false }]) });
    })); root.append(toolbar);
    if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); root.append(message); }
    if (!layout) root.append(node('p', 'Loading source settings panels…'));
    else {
      if (!layout.instances.length) root.append(node('p', 'Add a panel to view and edit Source settings.'));
      for (const [id, child] of mounted) if (!layout.instances.some(item => item.instanceId === id && item.contributionId === child.contribution)) {
        child.retired = true; child.handle?.dispose(); mounted.delete(id);
      }
      for (const stack of layout.columns.flat()) {
        const section = node('section');
        for (const id of stack.instances) {
          const instance = layout.instances.find(value => value.instanceId === id); if (!instance) continue;
          const tools = node('div'); tools.className = 'source-settings-tools';
          const title = composition!.discover().find(value => value.contributionId === instance.contributionId)?.title ?? instance.contributionId;
          tools.append(button(`${instance.hidden ? 'Show' : 'Hide'} ${title}`, () => {
            if (layout) void save({ ...layout, instances: layout.instances.map(value => value.instanceId === id ? { ...value, hidden: !value.hidden } : value) });
          }), button(`Open ${title}`, () => {
            if (layout) void save({ ...layout, instances: layout.instances.map(value => value.instanceId === id ? { ...value, hidden: false } : value),
              columns: layout.columns.map(column => column.map(value => value.instances.includes(id) ? { ...value, activeInstanceId: id, collapsed: false } : value)) });
          })); section.append(tools);
          let child = mounted.get(id);
          if (!child) {
            child = { node: node('div'), handle: null, retired: false, active: false, contribution: instance.contributionId }; mounted.set(id, child);
            const pending = child;
            void Promise.resolve().then(() => disposed || pending.retired ? null : composition!.mount(id, pending.node)).then(handle => {
              if (!handle) return;
              if (disposed || pending.retired) handle.dispose(); else { pending.handle = handle; handle.setActive(pending.active); }
            }).catch(() => { if (!disposed && !pending.retired) { pending.node.textContent = 'Panel unavailable. Its saved drafts are kept.'; pending.node.setAttribute('role', 'status'); } });
          }
          child.active = state.visible && !instance.hidden && !stack.collapsed && stack.activeInstanceId === id;
          child.node.hidden = !child.active; child.handle?.setActive(child.active); section.append(child.node);
        }
        root.append(section);
      }
    }
    container.replaceChildren(root);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
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

import type { CompositionLayoutV1, ManagedPanelInstanceV1, PluginPageModule } from '@helmsman/plugin-sdk';

const page: PluginPageModule = {
  mount(container, context) {
    const composition = context.composition;
    if (composition?.version !== 1 || composition.compositionId !== 'helmsman/helm-page') throw new Error('Workspace requires a compatible composition');
    const service = composition;
    let state = context.state;
    let layout: CompositionLayoutV1 | null = null;
    let disposed = false;
    let revision = 0;
    let saving = false;
    let error = '';
    let located: string | null = null;
    let pendingFocus: string | null = null;
    const children = new Map<string, { node: HTMLElement; handle: ManagedPanelInstanceV1 | null; contribution: string; retired: boolean; active: boolean }>();
    function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
    function action(label: string, fn: () => void) { const value = node('button', label); value.type = 'button'; value.disabled = saving; value.addEventListener('click', fn); return value; }
    async function reload() {
      const generation = ++revision;
      try { const value = await service.readLayout(); if (!disposed && generation === revision) { if (!layout || value.revision >= layout.revision) layout = value; error = ''; revealLocator(); draw(); } }
      catch { if (!disposed && generation === revision) { error = 'Saved workspace unavailable. Retry to reconnect.'; draw(); } }
    }
    async function save(next: CompositionLayoutV1) {
      if (disposed || saving || !layout) return;
      const expected = layout.revision; saving = true; draw();
      try { const value = await service.updateLayout(next, expected); if (!disposed) { if (!layout || value.revision >= layout.revision) layout = value; error = ''; } }
      catch { if (!disposed) error = 'Workspace could not be saved. Reload and retry.'; }
      finally { if (!disposed) { saving = false; revealLocator(); draw(); } }
    }
    function locatorInstance(): string | null {
      if (!layout) return null;
      const exact = layout.instances.find(value => value.instanceId === state.panelInstance);
      return exact?.instanceId ?? (state.panelContribution ? layout.instances.find(value => value.contributionId === state.panelContribution)?.instanceId : null) ?? null;
    }
    function revealLocator() {
      const id = locatorInstance();
      if (!id) { located = null; return; }
      if (!layout || located === id || saving) return;
      const instance = layout.instances.find(value => value.instanceId === id);
      const stack = layout.columns.flat().find(value => value.instances.includes(id));
      if (!instance || !stack) return;
      located = id; pendingFocus = id;
      if (instance.hidden || stack.collapsed || stack.activeInstanceId !== id) void save({ ...layout,
        instances: layout.instances.map(value => value.instanceId === id ? { ...value, hidden: false } : value),
        columns: layout.columns.map(column => column.map(value => value.instances.includes(id) ? { ...value, activeInstanceId: id, collapsed: false } : value)),
      });
    }
    function draw() {
      if (disposed) return;
      const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
      const focusedInstance = focused?.dataset.workspaceInstance;
      const root = node('div'); root.className = 'alternative-helm';
      const style = node('style', '.alternative-helm{display:grid;gap:16px;color:var(--text);font:14px var(--sans,sans-serif)}.alternative-helm h1{font-size:18px}.alternative-helm section{border:1px solid var(--line);padding:12px;border-radius:var(--radius,4px);background:var(--panel)}.alternative-helm .workspace-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.alternative-helm button,.alternative-helm select{font:inherit;padding:6px;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong)}.alternative-helm [hidden]{display:none}.alternative-helm [role=alert]{color:var(--bad)}.alternative-helm button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}');
      root.append(style, node('h1', state.pirateMode ? 'Chart table' : 'Workspace'));
      const toolbar = node('div'); toolbar.className = 'workspace-tools'; toolbar.append(action('Reload workspace', () => { void reload(); }));
      const choose = node('select'); choose.setAttribute('aria-label', 'Available panel');
      for (const candidate of service.discover()) { const option = node('option', candidate.title); option.value = candidate.contributionId; choose.append(option); }
      toolbar.append(choose, action('Add to workspace', () => {
        if (!layout || !choose.value) return;
        const id = crypto.randomUUID();
        const columns = layout.columns.length ? layout.columns.map(column => [...column]) : [[]];
        columns[0]!.push({ instances: [id], activeInstanceId: id, collapsed: false });
        void save({ ...layout, instances: [...layout.instances, { instanceId: id, contributionId: choose.value, hidden: false, scope: { kind: 'inherit' }, state: {} }], columns });
      })); root.append(toolbar);
      if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); root.append(message); }
      if (!layout) { root.append(node('p', 'Loading workspace…')); container.replaceChildren(root); return; }
      if ((state.panelInstance || state.panelContribution) && !locatorInstance()) { const missing = node('p', `The requested panel (${state.panelInstance ?? state.panelContribution}) is not present in this layout. Your saved layout is kept.`); missing.setAttribute('role', 'status'); root.append(missing); }
      const currentLayout = layout;
      for (const [id, child] of children) if (!currentLayout.instances.some(instance => instance.instanceId === id && instance.contributionId === child.contribution)) { child.retired = true; child.handle?.dispose(); children.delete(id); }
      for (const stack of currentLayout.columns.flat()) {
        const group = node('section'); const tabs = node('div'); tabs.className = 'workspace-tools';
        for (const id of stack.instances) {
          const instance = currentLayout.instances.find(value => value.instanceId === id); if (!instance) continue;
          const title = service.discover().find(value => value.contributionId === instance.contributionId)?.title ?? `Unavailable: ${instance.contributionId}`;
          const select = action(title, () => { if (layout) void save({ ...layout, columns: layout.columns.map(column => column.map(value => value.instances.includes(id) ? { ...value, activeInstanceId: id, collapsed: false } : value)) }); });
          select.setAttribute('aria-pressed', String(stack.activeInstanceId === id)); select.dataset.workspaceInstance = id; tabs.append(select);
          tabs.append(action(instance.hidden ? `Show ${title}` : `Hide ${title}`, () => {
            if (!layout) return;
            const instances = layout.instances.map(value => value.instanceId === id ? { ...value, hidden: !value.hidden } : value);
            const columns = !instance.hidden ? layout.columns.map(column => column.map(value => {
              const visible = value.instances.find(candidate => instances.some(item => item.instanceId === candidate && !item.hidden));
              return value.activeInstanceId === id && visible ? { ...value, activeInstanceId: visible } : value;
            })) : layout.columns;
            void save({ ...layout, instances, columns });
          }));
        }
        group.append(tabs);
        for (const id of stack.instances) {
          const instance = currentLayout.instances.find(value => value.instanceId === id); if (!instance) continue;
          let child = children.get(id);
          if (!child) {
            child = { node: node('div'), handle: null, contribution: instance.contributionId, retired: false, active: false }; children.set(id, child);
            const pending = child;
            void Promise.resolve().then(() => disposed || pending.retired ? null : service.mount(id, pending.node)).then(handle => { if (!handle) return; if (disposed || pending.retired) handle.dispose(); else { pending.handle = handle; handle.setActive(pending.active); } })
              .catch(() => { if (!disposed && !pending.retired) pending.node.textContent = 'Panel unavailable. The selection is retained.'; });
          }
          child.active = state.visible && !instance.hidden && !stack.collapsed && stack.activeInstanceId === id;
          child.node.hidden = !child.active; child.handle?.setActive(child.active); group.append(child.node);
        }
        root.append(group);
      }
      container.replaceChildren(root);
      if (!saving && pendingFocus && currentLayout.instances.some(value => value.instanceId === pendingFocus && !value.hidden)
        && currentLayout.columns.flat().some(value => value.activeInstanceId === pendingFocus && !value.collapsed)) {
        const target = Array.from(container.querySelectorAll<HTMLElement>('[data-workspace-instance]')).find(value => value.dataset.workspaceInstance === pendingFocus);
        if (target) { target.focus({ preventScroll: true }); pendingFocus = null; }
      } else if (focused?.isConnected && container.contains(focused)) focused.focus({ preventScroll: true });
      else if (focusedInstance) Array.from(container.querySelectorAll<HTMLElement>('[data-workspace-instance]')).find(value => value.dataset.workspaceInstance === focusedInstance)?.focus({ preventScroll: true });
    }
    const unsubscribe = service.subscribe(() => { void reload(); });
    function dispose() {
      if (disposed) return; disposed = true; revision++; unsubscribe(); context.signal.removeEventListener('abort', dispose);
      for (const child of children.values()) { child.retired = true; child.handle?.dispose(); } children.clear();
    }
    context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true });
    if (context.signal.aborted) dispose(); else void reload();
    return { update(next) { if (!disposed) { state = next; revealLocator(); draw(); } }, async refresh() { await reload(); await Promise.all([...children.values()].filter(child => child.active).map(child => child.handle?.refresh())); }, dispose };
  },
};
export default page;

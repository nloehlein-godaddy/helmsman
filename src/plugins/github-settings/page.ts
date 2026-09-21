import type { CompositionLayoutV1, ManagedPanelInstanceV1, PluginPageModule } from '@helmsman/plugin-sdk';
const styles = '.github-settings-page .question-tools { display:flex; flex-wrap:wrap; gap:.5rem; margin:.5rem 0; }';

const page: PluginPageModule = { mount(container, context) {
  const composition = context.composition;
  if (composition?.version !== 1 || composition.compositionId !== 'helmsman/github-settings-page') throw new Error('GitHub settings requires its composition service');
  let state = context.state;
  let layout: CompositionLayoutV1 | null = null;
  let disposed = false; let generation = 0; let saving = false; let error = '';
  let located: string | null = null; let pendingFocus: string | null = null; let failedRoute: string | null = null;
  const mounted = new Map<string, { node: HTMLElement; handle: ManagedPanelInstanceV1 | null; retired: boolean; active: boolean; contribution: string }>();
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
  function button(label: string, action: () => void) { const value = node('button', label); value.type = 'button'; value.disabled = saving; value.addEventListener('click', action); return value; }
  async function read() {
    const current = ++generation;
    try {
      const next = await composition!.readLayout();
      if (disposed || current !== generation) return;
      if (!layout || next.revision >= layout.revision) layout = next;
      error = ''; revealRoute(); draw();
    } catch { if (!disposed && current === generation) { error = 'Your saved GitHub settings panels are unavailable. Refresh to retry.'; draw(); } }
  }
  async function save(next: CompositionLayoutV1, routeKey: string | null = null) {
    if (disposed || saving || !layout) return;
    const expected = layout.revision; saving = true; draw();
    try {
      const saved = await composition!.updateLayout(next, expected);
      if (!disposed && (!layout || saved.revision >= layout.revision)) layout = saved;
      error = '';
    } catch { if (!disposed) { await read(); if (routeKey && located === routeKey) failedRoute = routeKey; error = routeKey ? 'The requested panel could not be revealed. Its layout is kept. Refresh to retry.' : 'The layout changed or could not be saved. Review it and retry.'; } }
    finally { saving = false; revealRoute(); draw(); }
  }
  function routeTarget() {
    if (!layout) return null;
    if (state.panelInstance) { const exact = layout.instances.find(instance => instance.instanceId === state.panelInstance); if (exact) return exact; }
    return state.panelContribution ? layout.instances.find(instance => instance.contributionId === state.panelContribution) ?? null : null;
  }
  function revealRoute() {
    if (disposed || saving || !layout || !state.visible) return;
    const target = routeTarget();
    if (!target) { located = null; pendingFocus = null; return; }
    const key = JSON.stringify([state.panelInstance, state.panelContribution, state.panelRouteState, state.pane]);
    if (located === key) return;
    const stack = layout.columns.flat().find(value => value.instances.includes(target.instanceId));
    if (!stack) return;
    located = key; failedRoute = null; pendingFocus = target.instanceId;
    if (target.hidden || stack.collapsed || stack.activeInstanceId !== target.instanceId) void save({ ...layout,
      instances: layout.instances.map(value => value.instanceId === target.instanceId ? { ...value, hidden: false } : value),
      columns: layout.columns.map(column => column.map(value => value.instances.includes(target.instanceId) ? { ...value, activeInstanceId: target.instanceId, collapsed: false } : value)),
    }, key);
  }
  function draw() {
    if (disposed) return;
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
    let routedFocus: HTMLElement | null = null;
    const root = node('div'); root.className = 'github-settings-page'; root.append(node('style', styles), node('h1', 'GitHub settings'));
    const toolbar = node('div'); toolbar.className = 'question-tools'; toolbar.append(button('Refresh', () => { if (failedRoute === located) { located = null; failedRoute = null; } void refresh(); }));
    const options = node('select'); options.setAttribute('aria-label', 'GitHub settings panel implementation');
    for (const candidate of composition!.discover()) { const option = node('option', candidate.title); option.value = candidate.contributionId; options.append(option); }
    toolbar.append(options, button('Add panel', () => {
      if (!layout || !options.value) return;
      const id = crypto.randomUUID();
      void save({ ...layout, instances: [...layout.instances, { instanceId: id, contributionId: options.value, scope: { kind: 'inherit' }, state: {}, hidden: false }],
        columns: [...layout.columns, ...(layout.columns.length ? [] : [[]])].map((column, index) => index ? column : [...column, { instances: [id], activeInstanceId: id, collapsed: false }]) });
    })); root.append(toolbar);
    if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); root.append(message); }
    if (!layout) root.append(node('p', 'Loading GitHub settings panels…'));
    else {
      if ((state.panelInstance || state.panelContribution) && !routeTarget()) { const missing = node('p', `The requested panel (${state.panelInstance ?? state.panelContribution}) is not present in this layout. Your saved layout is kept.`); missing.setAttribute('role', 'status'); root.append(missing); }
      if (!layout.instances.length) root.append(node('p', 'Add a panel to view github-settings.'));
      for (const [id, child] of mounted) if (!layout.instances.some(item => item.instanceId === id && item.contributionId === child.contribution)) {
        child.retired = true; child.handle?.dispose(); mounted.delete(id);
      }
      for (const stack of layout.columns.flat()) {
        const section = node('section');
        for (const id of stack.instances) {
          const instance = layout.instances.find(value => value.instanceId === id); if (!instance) continue;
          const tools = node('div'); tools.className = 'question-tools';
          const title = composition!.discover().find(value => value.contributionId === instance.contributionId)?.title ?? instance.contributionId;
          tools.append(button(`${instance.hidden ? 'Show' : 'Hide'} ${title}`, () => {
            if (layout) void save({ ...layout, instances: layout.instances.map(value => value.instanceId === id ? { ...value, hidden: !value.hidden } : value) });
          }), button(`Open ${title}`, () => {
            if (layout) void save({ ...layout, instances: layout.instances.map(value => value.instanceId === id ? { ...value, hidden: false } : value),
              columns: layout.columns.map(column => column.map(value => value.instances.includes(id) ? { ...value, activeInstanceId: id, collapsed: false } : value)) });
          })); section.append(tools);
          let child = mounted.get(id);
          if (!child) {
            child = { node: node('div'), handle: null, retired: false, active: false, contribution: instance.contributionId }; child.node.tabIndex = -1; child.node.dataset.panelInstance = id; mounted.set(id, child);
            const pending = child;
            void Promise.resolve().then(() => disposed || pending.retired ? null : composition!.mount(id, pending.node)).then(handle => {
              if (!handle) return;
              if (disposed || pending.retired) handle.dispose(); else { pending.handle = handle; handle.setActive(pending.active); }
            }).catch(() => { if (!disposed && !pending.retired) { pending.node.textContent = 'Panel unavailable. Its saved state is kept.'; pending.node.setAttribute('role', 'status'); } });
          }
          child.active = state.visible && !instance.hidden && !stack.collapsed && stack.activeInstanceId === id;
          child.node.hidden = !child.active; child.handle?.setActive(child.active);
          if (pendingFocus === id && document.activeElement instanceof HTMLElement && child.node.contains(document.activeElement)) routedFocus = document.activeElement;
          section.append(child.node);
        }
        root.append(section);
      }
    }
    container.replaceChildren(root);
    const target = pendingFocus ? mounted.get(pendingFocus) : null;
    if (target?.active && target.node.isConnected) { pendingFocus = null; const control = routedFocus ?? (focused && target.node.contains(focused) ? focused : target.node); control.focus({ preventScroll: true }); target.node.scrollIntoView?.({ block: 'start' }); }
    else if (focused?.isConnected) focused.focus({ preventScroll: true });
  }
  async function refresh() { await read(); const results = await Promise.allSettled([...mounted.values()].filter(value => value.active).map(async value => value.handle?.refresh())); if (!disposed && results.some(result => result.status === 'rejected')) { error = 'Some panels could not be refreshed. Their saved state is kept.'; draw(); } }
  const unsubscribe = composition.subscribe(() => { void read(); });
  function dispose() {
    if (disposed) return; disposed = true; ++generation; unsubscribe(); context.signal.removeEventListener('abort', dispose);
    for (const child of mounted.values()) { child.retired = true; child.handle?.dispose(); } mounted.clear();
  }
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose(); else void read();
  return { update(next) { if (!disposed) { state = next; revealRoute(); draw(); } }, refresh, dispose };
} };
export default page;

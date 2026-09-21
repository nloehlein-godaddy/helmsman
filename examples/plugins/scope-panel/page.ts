import type { ManagedPanelInstanceV1, PluginPageModule } from '@helmsman/plugin-sdk';

const page: PluginPageModule = {
  mount(container, context) {
    const composition = context.composition;
    if (composition?.version !== 1) throw new Error('A version 1 composition is required.');
    let visible = context.state.visible;
    let disposed = false;
    let revision = 0;
    const children: { handle: ManagedPanelInstanceV1; active: boolean }[] = [];
    const clear = () => { for (const child of children.splice(0)) child.handle.dispose(); };
    const render = async () => {
      const generation = ++revision;
      const current = () => !disposed && generation === revision;
      try {
        const layout = await composition.readLayout();
        if (!current()) return;
        clear();
        const heading = document.createElement('h1');
        heading.textContent = 'Scope workspace';
        container.replaceChildren(heading);
        if (!layout.instances.length) container.append('Your saved layout is empty.');
        for (const stack of layout.columns.flat()) {
          for (const id of stack.instances) {
            if (!current()) return;
            const instance = layout.instances.find(item => item.instanceId === id);
            if (!instance) continue;
            const active = !instance.hidden && !stack.collapsed && stack.activeInstanceId === id;
            const target = document.createElement('section');
            target.hidden = !active;
            container.append(target);
            const handle = await composition.mount(id, target);
            if (!current()) { handle.dispose(); return; }
            children.push({ handle, active });
            handle.setActive(visible && active);
          }
        }
      } catch {
        if (current()) { clear(); container.textContent = 'Workspace unavailable. Your saved layout is retained.'; }
      }
    };
    const unsubscribe = composition.subscribe(() => { void render(); });
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      revision++;
      unsubscribe();
      clear();
      container.replaceChildren();
    };
    context.onDispose(dispose);
    void render();
    return {
      update(state) { visible = state.visible; for (const child of children) child.handle.setActive(visible && child.active); },
      refresh: render,
      dispose,
    };
  },
};
export default page;

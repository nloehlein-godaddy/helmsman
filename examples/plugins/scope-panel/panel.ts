import type { PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';

const panel: PluginPanelModule = {
  mount(container, context) {
    const title = document.createElement('h2');
    title.textContent = 'Selected scope';
    const scope = document.createElement('p');
    container.replaceChildren(title, scope);
    const update = (state: PluginPanelState) => {
      scope.textContent = `${state.pirateMode ? 'Galleon' : 'Repository'}: ${state.activity.repo ?? 'All'}`;
    };
    update(context.state);
    return { update, dispose() { container.replaceChildren(); } };
  },
};
export default panel;

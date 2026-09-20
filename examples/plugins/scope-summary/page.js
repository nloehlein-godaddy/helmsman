export default {
  mount(container, context) {
    let state = context.state;
    const heading = document.createElement('h1');
    heading.textContent = 'External scope summary';
    const label = document.createElement('p');
    const scope = document.createElement('strong');
    scope.dataset.sampleScope = '';
    const button = document.createElement('button');
    button.textContent = 'Open runs';
    container.style.padding = '24px';
    button.style.padding = '8px 16px';
    container.replaceChildren(heading, label, scope, document.createElement('hr'), button);
    const navigate = () => context.navigate(`/runs${state.repo ? `?repo=${encodeURIComponent(state.repo)}` : ''}`);
    button.addEventListener('click', navigate);
    const update = next => {
      state = next;
      label.textContent = state.pirateMode ? 'Current galleon' : 'Current repository';
      scope.textContent = state.repo ?? 'All';
      container.dataset.sampleTheme = state.themeId;
    };
    update(state);
    const dispose = () => button.removeEventListener('click', navigate);
    context.onDispose(dispose);
    return { update, dispose };
  },
};

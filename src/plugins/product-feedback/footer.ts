import type { PluginPageModule } from '@helmsman/plugin-sdk';
const footer: PluginPageModule = { mount(container, context) {
  const service = context.services?.feedbackCommands;
  if (service?.version !== 1) throw new Error('Feedback entry requires its public command service.');
  let state = context.state; let available = false; let disposed = false; let generation = 0; let controller = new AbortController();
  function draw() {
    if (disposed) return;
    const link = document.createElement('a'); link.textContent = 'Product feedback'; link.dataset.productFeedback = '';
    link.href = `${available ? '/product-feedback' : '/feedback-settings'}${state.repo ? `?repo=${encodeURIComponent(state.repo)}` : ''}`;
    link.addEventListener('click', event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); context.navigate(link.getAttribute('href')!); });
    container.replaceChildren(link);
  }
  async function refresh() {
    if (disposed || !state.visible) return; const current = ++generation;
    try { const result = await service!.destination(controller.signal); if (!disposed && current === generation) { available = result.status === 'available' && result.value !== null; draw(); } }
    catch { if (!disposed && current === generation) { available = false; draw(); } }
  }
  function dispose() { disposed = true; ++generation; controller.abort(); }
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true }); draw(); void refresh();
  return { async update(next) { const changed = state.repo !== next.repo || state.visible !== next.visible; state = next; if (changed) { ++generation; controller.abort(); controller = new AbortController(); available = false; draw(); await refresh(); } }, refresh, dispose };
} };
export default footer;

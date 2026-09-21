import type { PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validName(value: unknown, limit: number): value is string | null {
  return value === null || typeof value === 'string' && value.length <= limit && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function suffix(result: unknown): string {
  const response = object(result);
  const snapshot = object(response?.value);
  const profile = object(snapshot?.profile);
  if (response?.status !== 'available' || snapshot?.version !== 1 || snapshot.scope !== 'global' || !profile
    || !validName(profile.displayName, 256) || !validName(profile.login, 128)) return '';
  const name = profile.displayName ?? profile.login;
  return name === null ? '' : `, ${name}`;
}

class ProfileHeader implements PluginPageInstance {
  private state: PluginPageState;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private readonly node = document.createElement('span');
  private readonly context: PluginPageContext;

  constructor(container: HTMLElement, context: PluginPageContext) {
    this.context = context;
    this.state = context.state;
    this.node.className = 'plugin-profile-name';
    this.node.style.cssText = 'display:inline;overflow-wrap:anywhere;';
    container.replaceChildren(this.node);
    context.signal.addEventListener('abort', this.dispose, { once: true });
    context.onDispose(this.dispose);
    if (context.signal.aborted) this.dispose();
    else void this.refresh();
  }

  private active(generation = this.generation): boolean {
    return !this.disposed && !this.context.signal.aborted && this.state.visible && generation === this.generation;
  }

  private cancel(): void {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
  }

  update(state: PluginPageState): void {
    if (this.disposed) return;
    const changed = this.state.visible !== state.visible;
    this.state = state;
    if (!changed) return;
    this.cancel();
    this.node.textContent = '';
    if (state.visible) void this.refresh();
  }

  refresh = async (): Promise<void> => {
    if (!this.active()) return;
    this.cancel();
    const generation = this.generation;
    const service = this.context.services?.profile;
    if (service?.version !== 1 || typeof service.snapshot !== 'function') {
      this.node.textContent = '';
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await service.snapshot({ version: 1, scope: 'global' }, controller.signal);
      if (this.active(generation)) this.node.textContent = suffix(result);
    } catch {
      if (this.active(generation)) this.node.textContent = '';
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.context.signal.removeEventListener('abort', this.dispose);
    this.node.remove();
  };
}

const header: PluginPageModule = { mount: (container, context) => new ProfileHeader(container, context) };
export default header;

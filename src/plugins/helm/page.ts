import type { CompositionLayoutV1, CompositionServiceV1, ManagedPanelInstanceV1, PanelScopeV1, PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
import { addInstance, changeInstance, moveInstance, removeInstance, stackInstance } from './layout.js';
import { styles } from './styles.js';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
const button = (text: string, action: () => void, disabled = false) => {
  const value = element('button', text); value.type = 'button'; value.disabled = disabled; value.addEventListener('click', action); return value;
};
const iconButton = (label: string, path: string, action: () => void, disabled = false) => {
  const value = button('', action, disabled); value.className = 'composition-icon-button'; value.setAttribute('aria-label', label); value.title = label;
  value.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  return value;
};
interface Mounted { element: HTMLElement; handle: ManagedPanelInstanceV1 | null; contributionId: string; active: boolean; retired: boolean; }

class HelmPage implements PluginPageInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPageContext;
  private readonly composition: CompositionServiceV1;
  private state: PluginPageState;
  private layout: CompositionLayoutV1 | null = null;
  private mounted = new Map<string, Mounted>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private generation = 0;
  private saving = false;
  private error = '';
  private editing = false;
  private located: string | null = null;
  private pendingFocus: string | null = null;
  private scopeDrafts = new Map<string, { kind: string; repo: string }>();
  private narrow = window.innerWidth <= 760;
  private grid: HTMLElement | null = null;
  private columns: { element: HTMLElement; stacks: HTMLElement[] }[] = [];
  private readonly mobileColumn = element('div');
  private resize = (): void => {
    const narrow = window.innerWidth <= 760;
    if (this.disposed || narrow === this.narrow) return;
    this.narrow = narrow; this.arrangeColumns();
  };
  private arrangeColumns(): void {
    if (!this.grid) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    if (this.narrow) {
      const count = Math.max(0, ...this.columns.map(column => column.stacks.length));
      const stacks = Array.from({ length: count }, (_, index) => this.columns.flatMap(column => column.stacks[index] ? [column.stacks[index]!] : [])).flat();
      this.mobileColumn.className = 'helm-column'; this.mobileColumn.replaceChildren(...stacks); this.grid.replaceChildren(this.mobileColumn);
    } else {
      for (const column of this.columns) column.element.replaceChildren(...column.stacks);
      this.grid.replaceChildren(...this.columns.map(column => column.element));
    }
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }
  constructor(container: HTMLElement, context: PluginPageContext, composition: CompositionServiceV1) {
    this.container = container; this.context = context; this.composition = composition; this.state = context.state;
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.abort, { once: true });
    if (context.signal.aborted) { this.dispose(); return; }
    window.addEventListener('resize', this.resize);
    this.unsubscribe = composition.subscribe(() => { void this.read(); });
    void this.read();
  }
  private abort = () => this.dispose();
  private async read(): Promise<void> {
    const generation = ++this.generation;
    try {
      const layout = await this.composition.readLayout();
      if (this.disposed || generation !== this.generation) return;
      if (!this.layout || layout.revision >= this.layout.revision) this.layout = layout;
      this.error = ''; this.revealLocator(); this.draw();
    } catch { if (!this.disposed && generation === this.generation) { this.error = 'Layout is unavailable. Retry without resetting your saved panels.'; this.draw(); } }
  }
  private locatorInstance(): string | null {
    const id = this.state.panelInstance ?? null;
    if (!this.layout) return null;
    if (id && this.layout.instances.some(instance => instance.instanceId === id)) return id;
    if (this.state.panelContribution) {
      return this.layout.instances.find(instance => instance.contributionId === this.state.panelContribution)?.instanceId ?? null;
    }
    return null;
  }
  private revealLocator(): void {
    const id = this.locatorInstance();
    if (!id) { this.located = null; return; }
    if (id === this.located || !this.layout || this.saving) return;
    const instance = this.layout.instances.find(value => value.instanceId === id);
    const stack = this.layout.columns.flat().find(value => value.instances.includes(id));
    if (!instance || !stack) return;
    this.located = id; this.pendingFocus = id;
    if (instance.hidden || stack.collapsed || stack.activeInstanceId !== id) void this.save(layout => ({ ...layout,
      instances: layout.instances.map(value => value.instanceId === id ? { ...value, hidden: false } : value),
      columns: layout.columns.map(column => column.map(value => value.instances.includes(id) ? { ...value, activeInstanceId: id, collapsed: false } : value)),
    }));
  }
  private async save(change: (layout: CompositionLayoutV1) => CompositionLayoutV1): Promise<boolean> {
    if (this.disposed || this.saving || !this.layout) return false;
    const focusedControl = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.helmFocus : null;
    const previous = this.layout; this.saving = true; this.error = ''; this.draw();
    let saved = false;
    try {
      const next = await this.composition.updateLayout(change(previous), previous.revision);
      if (!this.disposed && (!this.layout || next.revision >= this.layout.revision)) this.layout = next;
      saved = true;
    } catch {
      if (!this.disposed) {
        try { const latest = await this.composition.readLayout(); if (!this.layout || latest.revision >= this.layout.revision) this.layout = latest; } catch { /* Keep the last readable layout until the store recovers. */ }
        this.error = 'The layout changed or could not be saved. Review the current layout and retry.';
      }
    } finally { if (!this.disposed) {
      this.saving = false; this.revealLocator(); this.draw();
      if (focusedControl && document.activeElement === document.body) (Array.from(this.container.querySelectorAll<HTMLElement>('[data-helm-focus]')).find(control => control.dataset.helmFocus === focusedControl) ?? this.container.querySelector<HTMLButtonElement>('[data-helm-focus="page:edit"]'))?.focus({ preventScroll: true });
    } }
    return saved;
  }
  private async saveScope(id: string, scope: PanelScopeV1): Promise<void> {
    if (await this.save(layout => changeInstance(layout, id, { scope }))) { this.scopeDrafts.delete(id); this.draw(); }
  }
  private title(contributionId: string): string { return this.composition.discover().find(panel => panel.contributionId === contributionId)?.title ?? `Unavailable: ${contributionId}`; }
  private panel(id: string, contributionId: string, active: boolean): HTMLElement {
    let value = this.mounted.get(id);
    if (value && value.contributionId !== contributionId) { value.retired = true; value.handle?.dispose(); this.mounted.delete(id); value = undefined; }
    if (!value) {
      const content = element('div'); content.className = 'helm-panel-body'; content.dataset.panelInstance = id;
      value = { element: content, contributionId, handle: null, active, retired: false }; this.mounted.set(id, value);
      const mounted = value;
      void Promise.resolve().then(() => this.disposed || mounted.retired ? null : this.composition.mount(id, content)).then(handle => {
        if (!handle) return;
        if (this.disposed || mounted.retired) { handle.dispose(); return; }
        mounted.handle = handle; handle.setActive(mounted.active);
      }).catch(() => { if (!this.disposed && !mounted.retired) { content.textContent = 'This panel is unavailable. Its saved state is kept.'; content.setAttribute('role', 'status'); } });
    }
    value.active = active; value.element.hidden = !active; value.handle?.setActive(active); return value.element;
  }
  private draw(): void {
    if (this.disposed) return;
    const focusedElement = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const focused = focusedElement?.dataset.helmFocus;
    const page = element('div'); page.className = 'plugin-helm'; const style = element('style', styles); page.append(style);
    const toolbar = element('header'); toolbar.className = 'helm-tools composition-page-header'; toolbar.append(element('h1', this.state.pirateMode ? 'Helm' : 'Dashboard'));
    const actions = element('div'); actions.className = 'composition-page-actions';
    const refresh = iconButton('Refresh page', 'M20 11a8 8 0 0 0-14.5-4.5L3 9m0-6v6h6 M4 13a8 8 0 0 0 14.5 4.5L21 15m0 6v-6h-6', () => { void this.refresh(); }, this.saving); refresh.dataset.helmFocus = 'page:refresh'; actions.append(refresh);
    const edit = this.editing ? button('Done', () => { this.editing = false; this.draw(); }, this.saving)
      : iconButton('Edit page', 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z', () => { this.editing = true; this.draw(); }, this.saving);
    edit.classList.add('composition-page-edit'); edit.setAttribute('aria-label', this.editing ? 'Done editing page' : 'Edit page'); edit.setAttribute('aria-pressed', String(this.editing)); edit.title = this.editing ? 'Done editing page' : 'Edit page'; edit.dataset.helmFocus = 'page:edit'; actions.append(edit); toolbar.append(actions); page.append(toolbar);
    if (this.error) { const message = element('p', this.error); message.setAttribute('role', 'alert'); page.append(message); }
    const layout = this.layout;
    if (!layout) { page.append(element('p', this.error ? 'Your layout is kept.' : 'Loading panels…')); this.container.replaceChildren(page); return; }
    if ((this.state.panelInstance || this.state.panelContribution) && !this.locatorInstance()) { const missing = element('p', `The requested panel (${this.state.panelInstance ?? this.state.panelContribution}) is not present in this layout. Your saved layout is kept.`); missing.setAttribute('role', 'status'); page.append(missing); }
    const retained = new Set(layout.instances.map(instance => instance.instanceId));
    for (const id of this.scopeDrafts.keys()) if (!retained.has(id)) this.scopeDrafts.delete(id);
    for (const [id, mounted] of this.mounted) if (!retained.has(id)) { mounted.retired = true; mounted.handle?.dispose(); this.mounted.delete(id); }
    const manager = element('section'); manager.className = 'composition-page-editor'; manager.setAttribute('role', 'region'); manager.setAttribute('aria-label', 'Page customization'); manager.hidden = !this.editing;
    const controls = element('div'); controls.className = 'helm-config';
    const add = element('select'); add.setAttribute('aria-label', 'Panel to add');
    for (const panel of this.composition.discover()) { const option = element('option', panel.title); option.value = panel.contributionId; add.append(option); }
    const addRow = element('div'); addRow.className = 'helm-config-row'; addRow.append(add, button('Add panel', () => { if (add.value) void this.save(value => addInstance(value, add.value)); }, this.saving || !add.options.length)); controls.append(addRow);
    for (const instance of layout.instances) {
      const row = element('div'); row.className = 'helm-config-row'; row.append(element('strong', this.title(instance.contributionId)));
      const identity = `${this.title(instance.contributionId)} · ${instance.instanceId}`;
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', identity);
      const focus = (control: HTMLElement, suffix: string) => { control.dataset.helmFocus = `${instance.instanceId}:${suffix}`; return control; };
      row.append(focus(button(instance.hidden ? 'Show' : 'Hide', () => { void this.save(value => changeInstance(value, instance.instanceId, { hidden: !instance.hidden })); }, this.saving), 'hidden'));
      row.append(focus(button('Duplicate', () => { void this.save(value => addInstance(value, instance.contributionId, instance.scope)); }, this.saving), 'duplicate'));
      row.append(focus(button('Remove', () => { void this.save(value => removeInstance(value, instance.instanceId)); }, this.saving), 'remove'));
      const replacement = element('select'); replacement.setAttribute('aria-label', `Implementation for ${this.title(instance.contributionId)}`);
      const contributions = [...new Set([instance.contributionId, ...this.composition.discover().map(panel => panel.contributionId)])];
      for (const id of contributions) { const option = element('option', this.title(id)); option.value = id; replacement.append(option); }
      replacement.value = instance.contributionId; replacement.disabled = this.saving;
      replacement.addEventListener('change', () => { void this.save(value => changeInstance(value, instance.instanceId, { contributionId: replacement.value })); }); row.append(focus(replacement, 'implementation'));
      const scope = element('select'); scope.setAttribute('aria-label', `Scope for ${this.title(instance.contributionId)}`);
      for (const [id, label] of [['inherit', 'Follow header'], ['all', this.state.pirateMode ? 'All galleons' : 'All repositories'], ['galleon', this.state.pirateMode ? 'One galleon' : 'One repository']]) { const option = element('option', label); option.value = id!; scope.append(option); }
      const draft = this.scopeDrafts.get(instance.instanceId);
      scope.value = draft?.kind ?? instance.scope.kind; scope.disabled = this.saving; row.append(focus(scope, 'scope'));
      const repo = element('input'); repo.placeholder = 'owner/project'; repo.setAttribute('aria-label', this.state.pirateMode ? 'Panel galleon' : 'Panel repository'); repo.value = draft?.repo ?? (instance.scope.kind === 'galleon' ? instance.scope.repo : this.state.repo ?? ''); repo.hidden = scope.value !== 'galleon'; repo.disabled = this.saving; row.append(focus(repo, 'repo'));
      repo.addEventListener('input', () => { this.scopeDrafts.set(instance.instanceId, { kind: scope.value, repo: repo.value }); });
      scope.addEventListener('change', () => {
        this.scopeDrafts.set(instance.instanceId, { kind: scope.value, repo: repo.value });
        repo.hidden = scope.value !== 'galleon';
        if (scope.value !== 'galleon') void this.saveScope(instance.instanceId, { kind: scope.value === 'all' ? 'all' : 'inherit' });
        else repo.focus();
      });
      row.append(button('Apply scope', () => {
        const value = repo.value.trim();
        if (scope.value === 'galleon' && value.length <= 512 && /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(value) && !['.', '..'].includes(value.split('/')[1]!)) void this.saveScope(instance.instanceId, { kind: 'galleon', repo: value });
        else if (scope.value === 'galleon') { this.error = `Enter a ${this.state.pirateMode ? 'galleon' : 'repository'} as owner/project.`; this.draw(); }
      }, this.saving));
      for (const direction of ['up', 'down', 'left', 'right'] as const) row.append(focus(button(`Move ${direction}`, () => { void this.save(value => moveInstance(value, instance.instanceId, direction)); }, this.saving), `move-${direction}`));
      const stack = element('select'); stack.setAttribute('aria-label', 'Stack with panel');
      const choose = element('option', 'Choose a panel'); choose.value = ''; stack.append(choose);
      for (const other of layout.instances) if (other.instanceId !== instance.instanceId) { const option = element('option', `${this.title(other.contributionId)} · ${other.instanceId}`); option.value = other.instanceId; stack.append(option); }
      row.append(stack, button('Stack', () => { if (stack.value) void this.save(value => stackInstance(value, instance.instanceId, stack.value)); }, this.saving));
      for (const control of row.querySelectorAll<HTMLElement>('button, input, select')) {
        control.setAttribute('aria-label', `${control.getAttribute('aria-label') ?? control.textContent} · ${identity}`);
      }
      controls.append(row);
    }
    if (this.editing) manager.append(controls); page.append(manager);
    const grid = element('div'); grid.className = 'helm-columns'; grid.style.setProperty('--helm-columns', String(Math.max(1, layout.columns.length)));
    this.grid = grid; this.columns = [];
    for (const column of layout.columns) {
      const columnElement = element('div'); columnElement.className = 'helm-column';
      const stacks: HTMLElement[] = [];
      for (const stack of column) {
        const section = element('section'); section.className = 'helm-stack';
        const tabs = element('div'); tabs.className = 'helm-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Panels');
        tabs.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (current < 0 || !buttons.length) return;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
          event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
        });
        for (const id of stack.instances) {
          const instance = layout.instances.find(value => value.instanceId === id); if (!instance) continue;
          if (!instance.hidden) {
            const tab = button(this.title(instance.contributionId), () => { void this.save(value => ({ ...value, columns: value.columns.map(items => items.map(item => item.instances.includes(id) ? { ...item, activeInstanceId: id } : item)) })); }, this.saving);
            tab.setAttribute('role', 'tab'); tab.id = `helm-tab-${id}`; tab.setAttribute('aria-controls', `helm-body-${id}`);
            const focusId = stack.instances.find(candidate => candidate === stack.activeInstanceId && layout.instances.some(value => value.instanceId === candidate && !value.hidden))
              ?? stack.instances.find(candidate => layout.instances.some(value => value.instanceId === candidate && !value.hidden));
            tab.setAttribute('aria-selected', String(stack.activeInstanceId === id)); tab.tabIndex = focusId === id ? 0 : -1; tab.dataset.helmFocus = `${id}:tab`; tabs.append(tab);
          }
        }
        const collapse = button('', () => { void this.save(value => ({ ...value, columns: value.columns.map(items => items.map(item => item.instances.includes(stack.activeInstanceId) ? { ...item, collapsed: !item.collapsed } : item)) })); }, this.saving);
        collapse.className = 'helm-collapse';
        collapse.setAttribute('aria-label', `${stack.collapsed ? 'Expand' : 'Collapse'} ${this.title(layout.instances.find(instance => instance.instanceId === stack.activeInstanceId)?.contributionId ?? '')}`);
        collapse.title = stack.collapsed ? 'Expand panel' : 'Collapse panel';
        collapse.setAttribute('aria-controls', `helm-body-${stack.activeInstanceId}`);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.75'); icon.setAttribute('aria-hidden', 'true');
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path'); chevron.setAttribute('d', 'm6 9 6 6 6-6'); chevron.setAttribute('stroke-linecap', 'round'); chevron.setAttribute('stroke-linejoin', 'round'); icon.append(chevron); collapse.append(icon);
        collapse.setAttribute('aria-expanded', String(!stack.collapsed)); collapse.dataset.helmFocus = `${stack.activeInstanceId}:collapse`;
        const header = element('div'); header.className = 'helm-stack-header'; header.append(tabs, collapse); section.append(header);
        let shown = false;
        for (const id of stack.instances) {
          const instance = layout.instances.find(value => value.instanceId === id); if (!instance) continue;
          shown ||= !instance.hidden;
          const body = this.panel(id, instance.contributionId, this.state.visible && !instance.hidden && !stack.collapsed && stack.activeInstanceId === id);
          body.id = `helm-body-${id}`; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `helm-tab-${id}`); section.append(body);
        }
        section.hidden = !shown; stacks.push(section); columnElement.append(section);
      }
      this.columns.push({ element: columnElement, stacks }); grid.append(columnElement);
    }
    page.append(grid); if (!layout.instances.length) page.append(element('p', 'Add a panel to start your dashboard.'));
    this.container.replaceChildren(page); this.arrangeColumns();
    const target = this.pendingFocus && layout.instances.some(instance => instance.instanceId === this.pendingFocus && !instance.hidden)
      && layout.columns.flat().some(stack => stack.activeInstanceId === this.pendingFocus && !stack.collapsed)
      ? Array.from(this.container.querySelectorAll<HTMLElement>('[role="tab"]')).find(tab => tab.dataset.helmFocus === `${this.pendingFocus}:tab`) : null;
    if (target && !this.saving) { target.focus({ preventScroll: true }); this.pendingFocus = null; }
    else if (focusedElement?.isConnected && this.container.contains(focusedElement)) focusedElement.focus({ preventScroll: true });
    else if (focused) (Array.from(this.container.querySelectorAll<HTMLElement>('[data-helm-focus]')).find(control => control.dataset.helmFocus === focused) ?? edit)?.focus({ preventScroll: true });
  }
  update(state: PluginPageState): void { if (!this.disposed) { this.state = state; this.revealLocator(); this.draw(); } }
  async refresh(): Promise<void> { if (!this.disposed) { await this.read(); await Promise.all([...this.mounted.values()].filter(value => value.active).map(value => value.handle?.refresh())); } }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; ++this.generation; this.unsubscribe?.(); this.context.signal.removeEventListener('abort', this.abort);
    window.removeEventListener('resize', this.resize); this.grid = null; this.columns = [];
    for (const mounted of this.mounted.values()) { mounted.retired = true; mounted.handle?.dispose(); } this.mounted.clear();
  }
}

const page: PluginPageModule = { mount(container, context) {
  const composition = context.composition;
  if (!composition || composition.version !== 1 || composition.compositionId !== 'helmsman/helm-page') throw new Error('Helm requires its version 1 composition service');
  return new HelmPage(container, context, composition);
} };
export default page;

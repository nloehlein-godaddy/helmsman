import type { CompositionLayoutV1, CompositionServiceV1, ManagedPanelInstanceV1, PanelScopeV1, PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
import { addInstance, changeInstance, moveInstance, moveStack, removeInstance, stackInstance } from './layout.js';
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
interface Drag { id: string; grip: HTMLButtonElement; pointer: number | null; started: boolean; x: number; y: number; originX: number; originY: number; column: number; position: number; valid: boolean; }

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
  private drag: Drag | null = null;
  private dragFrame: number | null = null;
  private dragStatus: HTMLElement | null = null;
  private moveNotice = '';
  private readonly dragDescriptionId = `helm-move-${crypto.randomUUID()}`;
  private readonly mobileColumn = element('div');
  private resize = (): void => {
    this.cancelDrag();
    const narrow = window.innerWidth <= 760;
    if (this.disposed || narrow === this.narrow) return;
    this.narrow = narrow; this.arrangeColumns();
  };
  private clearDrop(): void {
    for (const node of this.container.querySelectorAll('.helm-drop-before,.helm-drop-after,.helm-drop-column')) node.classList.remove('helm-drop-before', 'helm-drop-after', 'helm-drop-column');
  }
  private cancelDrag = (): void => { this.clearDrag(true); };
  private announceMove(message: string): void { this.moveNotice = message; if (this.dragStatus) this.dragStatus.textContent = message; }
  private clearDrag(announce: boolean): void {
    const drag = this.drag; this.drag = null;
    if (this.dragFrame !== null) cancelAnimationFrame(this.dragFrame); this.dragFrame = null;
    window.removeEventListener('pointermove', this.pointerMove); window.removeEventListener('pointerup', this.pointerUp); window.removeEventListener('pointercancel', this.pointerCancel); window.removeEventListener('keydown', this.dragEscape);
    if (drag) { drag.grip.setAttribute('aria-pressed', 'false'); drag.grip.closest('.helm-stack')?.classList.remove('helm-dragging'); if (drag.pointer !== null && drag.grip.hasPointerCapture?.(drag.pointer)) drag.grip.releasePointerCapture(drag.pointer); }
    this.container.querySelector('.plugin-helm')?.classList.remove('helm-moving');
    this.clearDrop(); if (drag) this.announceMove(announce && drag.started ? 'Move canceled.' : '');
  }
  private dragEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && this.drag) { event.preventDefault(); this.cancelDrag(); } };
  private pointerCancel = (event: PointerEvent): void => { if (this.drag?.pointer === event.pointerId) this.cancelDrag(); };
  private markDrop(): void {
    this.clearDrop(); const drag = this.drag; if (!drag?.started || !drag.valid) return;
    const column = this.columns[drag.column]; if (!column) return;
    const next = column.stacks.find((stack, index) => index >= drag.position && !stack.hidden);
    const previous = column.stacks.slice(0, drag.position).reverse().find(stack => !stack.hidden);
    const cue = next ?? previous ?? (this.narrow ? this.mobileColumn.querySelector<HTMLElement>(`.helm-empty-target[data-helm-column="${drag.column}"]`) : column.element);
    cue?.classList.add(next ? 'helm-drop-before' : previous ? 'helm-drop-after' : 'helm-drop-column');
    const sourceColumn = this.layout?.columns.findIndex(items => items.some(stack => stack.instances.includes(drag.id))) ?? -1;
    const sourcePosition = this.layout?.columns[sourceColumn]?.findIndex(stack => stack.instances.includes(drag.id)) ?? -1;
    const position = drag.position - (sourceColumn === drag.column && sourcePosition < drag.position ? 1 : 0);
    const message = `Column ${drag.column + 1}, position ${position + 1}. ${drag.pointer === null ? 'Press Enter' : 'Release'} to place or Escape to cancel.`;
    if (this.dragStatus && this.dragStatus.textContent !== message) this.dragStatus.textContent = message;
    if (drag.pointer === null) cue?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  private pointDrop(): void {
    const drag = this.drag; const grid = this.grid; if (!drag || !grid) return;
    const bounds = grid.getBoundingClientRect(); drag.valid = drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
    if (!drag.valid) { this.markDrop(); return; }
    if (this.narrow) {
      const stacks = Array.from(this.mobileColumn.children).filter((value): value is HTMLElement => value instanceof HTMLElement && !value.hidden);
      const target = stacks.find(stack => { const rect = stack.getBoundingClientRect(); return drag.y < rect.top + rect.height / 2; }) ?? stacks.at(-1);
      if (target) { drag.column = Number(target.dataset.helmColumn); drag.position = Number(target.dataset.helmPosition) + (!target.classList.contains('helm-empty-target') && drag.y >= target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? 1 : 0); }
      else drag.valid = false;
    } else {
      drag.column = this.columns.findIndex(column => { const rect = column.element.getBoundingClientRect(); return drag.x < rect.right; });
      if (drag.column < 0) drag.column = this.columns.length - 1;
      const column = this.columns[drag.column];
      drag.position = column?.stacks.findIndex(stack => { const rect = stack.getBoundingClientRect(); return !stack.hidden && drag.y < rect.top + rect.height / 2; }) ?? -1;
      if (drag.position < 0) drag.position = column?.stacks.length ?? 0;
    }
    this.markDrop();
  }
  private scrollDrag = (): void => {
    this.dragFrame = null; const drag = this.drag; if (!drag?.started || drag.pointer === null) return;
    let scroll: HTMLElement | null = this.container;
    while (scroll && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
    scroll ??= document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
    if (scroll) {
      const viewport = scroll === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroll.getBoundingClientRect();
      const delta = drag.y < viewport.top + 56 ? -14 : drag.y > viewport.bottom - 56 ? 14 : 0;
      if (delta) scroll.scrollTop += delta;
    }
    this.pointDrop(); this.dragFrame = requestAnimationFrame(this.scrollDrag);
  };
  private beginDrag(grip: HTMLButtonElement, id: string, pointer: PointerEvent | null): void {
    if (!this.layout || this.saving || this.disposed) return;
    this.cancelDrag();
    this.announceMove('');
    const column = this.layout.columns.findIndex(items => items.some(stack => stack.instances.includes(id)));
    const position = this.layout.columns[column]?.findIndex(stack => stack.instances.includes(id)) ?? -1;
    if (position < 0) return;
    grip.focus({ preventScroll: true });
    this.drag = { id, grip, pointer: pointer?.pointerId ?? null, started: !pointer, x: pointer?.clientX ?? 0, y: pointer?.clientY ?? 0, originX: pointer?.clientX ?? 0, originY: pointer?.clientY ?? 0, column, position, valid: true };
    window.addEventListener('keydown', this.dragEscape);
    if (pointer) { grip.setPointerCapture?.(pointer.pointerId); window.addEventListener('pointermove', this.pointerMove); window.addEventListener('pointerup', this.pointerUp); window.addEventListener('pointercancel', this.pointerCancel); }
    else { grip.setAttribute('aria-pressed', 'true'); grip.closest('.helm-stack')?.classList.add('helm-dragging'); this.container.querySelector('.plugin-helm')?.classList.add('helm-moving'); this.markDrop(); }
  }
  private pointerMove = (event: PointerEvent): void => {
    const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.started && Math.hypot(drag.x - drag.originX, drag.y - drag.originY) < 6) return;
    event.preventDefault();
    if (!drag.started) { drag.started = true; drag.grip.setAttribute('aria-pressed', 'true'); drag.grip.closest('.helm-stack')?.classList.add('helm-dragging'); this.container.querySelector('.plugin-helm')?.classList.add('helm-moving'); this.dragFrame = requestAnimationFrame(this.scrollDrag); }
    this.pointDrop();
  };
  private finishDrag(): void {
    const drag = this.drag; const layout = this.layout; this.clearDrag(false);
    if (!drag?.started || !drag.valid || !layout || moveStack(layout, drag.id, drag.column, drag.position) === layout) return;
    void this.save(value => moveStack(value, drag.id, drag.column, drag.position)).then(saved => { if (saved && !this.disposed && !this.drag) this.announceMove('Panel moved.'); });
  }
  private pointerUp = (event: PointerEvent): void => { if (this.drag?.pointer !== event.pointerId) return; this.drag.x = event.clientX; this.drag.y = event.clientY; if (this.drag.started) this.pointDrop(); this.finishDrag(); };
  private gripKey(event: KeyboardEvent, grip: HTMLButtonElement, id: string): void {
    if (event.repeat && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); return; }
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (this.drag?.grip === grip) this.finishDrag(); else this.beginDrag(grip, id, null); return; }
    const drag = this.drag; const layout = this.layout;
    if (!drag || drag.grip !== grip || drag.pointer !== null || !layout || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { drag.column = Math.max(0, Math.min(layout.columns.length - 1, drag.column + (event.key === 'ArrowLeft' ? -1 : 1))); drag.position = Math.min(drag.position, layout.columns[drag.column]?.length ?? 0); }
    else {
      const sourceColumn = layout.columns.findIndex(column => column.some(stack => stack.instances.includes(id)));
      const sourcePosition = layout.columns[sourceColumn]?.findIndex(stack => stack.instances.includes(id));
      const slots = Array.from({ length: (layout.columns[drag.column]?.length ?? 0) + 1 }, (_, index) => index).filter(position => drag.column !== sourceColumn || position !== (sourcePosition ?? -2) + 1);
      const current = Math.max(0, slots.indexOf(drag.position));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? slots.length - 1 : Math.max(0, Math.min(slots.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
      drag.position = slots[next] ?? drag.position;
    }
    drag.valid = true; this.markDrop();
  }
  private arrangeColumns(): void {
    if (!this.grid) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    if (this.narrow) {
      const count = Math.max(0, ...this.columns.map(column => column.stacks.length));
      const stacks = Array.from({ length: count }, (_, index) => this.columns.flatMap(column => column.stacks[index] ? [column.stacks[index]!] : [])).flat();
      const empty = this.columns.flatMap((column, index) => {
        if (column.stacks.some(stack => !stack.hidden)) return [];
        const target = element('div', `Column ${index + 1}`); target.className = 'helm-empty-target'; target.dataset.helmColumn = String(index); target.dataset.helmPosition = String(column.stacks.length); return [target];
      });
      this.mobileColumn.className = 'helm-column'; this.mobileColumn.replaceChildren(...stacks, ...empty); this.grid.replaceChildren(this.mobileColumn);
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
    this.unsubscribe = composition.subscribe(() => { this.cancelDrag(); void this.read(); });
    void this.read();
  }
  private abort = () => this.dispose();
  private async read(): Promise<void> {
    this.cancelDrag();
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
    this.cancelDrag();
    const focusedElement = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const focused = focusedElement?.dataset.helmFocus;
    const page = element('div'); page.className = 'plugin-helm'; const style = element('style', styles); page.append(style);
    const instructions = element('p', 'Press Space or Enter to move this panel stack. Use arrow keys to choose a column and position, then Enter to place. Escape cancels.'); instructions.id = this.dragDescriptionId; instructions.className = 'helm-sr-only';
    this.dragStatus = element('p', this.moveNotice); this.dragStatus.className = 'helm-sr-only'; this.dragStatus.setAttribute('aria-live', 'polite'); this.dragStatus.setAttribute('aria-atomic', 'true'); page.append(instructions, this.dragStatus);
    const toolbar = element('div'); toolbar.className = 'helm-tools composition-page-header'; toolbar.append(element('h1', this.state.pirateMode ? 'Helm' : 'Dashboard'));
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
    for (const [columnIndex, column] of layout.columns.entries()) {
      const columnElement = element('div'); columnElement.className = 'helm-column';
      const stacks: HTMLElement[] = [];
      for (const [stackIndex, stack] of column.entries()) {
        const section = element('section'); section.className = 'helm-stack';
        section.dataset.helmColumn = String(columnIndex); section.dataset.helmPosition = String(stackIndex);
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
        const grip = iconButton(`Move ${this.title(layout.instances.find(instance => instance.instanceId === stack.activeInstanceId)?.contributionId ?? '')} panel · ${stack.activeInstanceId}`, 'M8 5h.01 M16 5h.01 M8 12h.01 M16 12h.01 M8 19h.01 M16 19h.01', () => {}, this.saving);
        grip.classList.add('helm-grip'); grip.dataset.helmFocus = `${stack.activeInstanceId}:move`; grip.setAttribute('aria-describedby', this.dragDescriptionId); grip.setAttribute('aria-pressed', 'false');
        grip.addEventListener('pointerdown', event => { if (event.button !== 0 || !event.isPrimary) return; this.beginDrag(grip, stack.activeInstanceId, event); });
        grip.addEventListener('click', event => { if (event.detail === 0 && (!this.drag || this.drag.pointer === null)) { if (this.drag?.grip === grip) this.finishDrag(); else this.beginDrag(grip, stack.activeInstanceId, null); } });
        grip.addEventListener('keydown', event => this.gripKey(event, grip, stack.activeInstanceId)); grip.addEventListener('lostpointercapture', event => { if (this.drag?.grip === grip && this.drag.pointer === event.pointerId) this.cancelDrag(); });
        const header = element('div'); header.className = 'helm-stack-header'; header.append(grip, tabs, collapse); section.append(header);
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
    this.cancelDrag();
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

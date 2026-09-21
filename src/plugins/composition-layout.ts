import { isContributionId, isSlotId } from './manifest';
import type { CompositionLayoutV1, PanelLayoutInstanceV1, PanelLayoutStackV1, PanelOpaqueStateV1, PanelScopeV1 } from './composition';

export class CompositionLayoutValidationError extends Error {}
export class CompositionLayoutConflictError extends Error {}

const layoutBytes = 4 * 1024 * 1024;
const stateBytes = 1024 * 1024;
const maxInstances = 128;
const instanceIdPattern = /^[a-z\d][a-z\d_.:-]{0,159}$/i;
const repoPattern = /^[a-z\d_.-]+\/[a-z\d_.-]+$/i;

function invalid(message: string): never { throw new CompositionLayoutValidationError(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a layout object.');
  return value as Record<string, unknown>;
}
function jsonCopy(value: unknown, bytes: number): unknown {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 32_768 || depth > 32) invalid('Layout data is too complex.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (item.length > bytes) invalid('Layout data is too large.'); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) invalid('Layout data must be JSON.');
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some(key => !/^(0|[1-9]\d*)$/.test(key)))) invalid('Layout arrays must contain only indexed values.');
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !property || !('value' in property) || !property.enumerable) invalid('Layout data must contain plain JSON properties.');
      visit(property.value, depth + 1);
    }
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > bytes) invalid('Layout data is too large.');
  return JSON.parse(encoded) as unknown;
}
function fields(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) invalid('Unexpected layout fields.');
}
function scope(value: unknown): PanelScopeV1 {
  const input = record(value);
  if (input.kind === 'inherit' || input.kind === 'all') { fields(input, ['kind']); return { kind: input.kind }; }
  if (input.kind !== 'galleon' || typeof input.repo !== 'string' || input.repo.length > 256 || !repoPattern.test(input.repo)
    || input.repo.split('/').some(part => part === '.' || part === '..')) invalid('Invalid panel galleon scope.');
  fields(input, ['kind', 'repo']); return { kind: 'galleon', repo: input.repo };
}
function states(value: unknown): PanelLayoutInstanceV1['state'] {
  const input = record(jsonCopy(value, stateBytes));
  if (Object.keys(input).length > 32) invalid('Too many panel state owners.');
  for (const [key, saved] of Object.entries(input)) {
    if (!key || key.length > 240 || /[\x00-\x1f\x7f]/.test(key)) invalid('Invalid panel state owner.');
    const state = record(saved); fields(state, ['version', 'value']);
    if (!Number.isSafeInteger(state.version) || (state.version as number) < 1) invalid('Invalid panel state version.');
  }
  return input as unknown as PanelLayoutInstanceV1['state'];
}

export function parsePanelOpaqueState(value: unknown): PanelOpaqueStateV1 | null {
  if (value === null) return null;
  const saved = states({ saved: value }).saved;
  if (!saved) invalid('Missing panel state.');
  return saved;
}

export function samePanelOpaqueState(first: PanelOpaqueStateV1 | null, second: PanelOpaqueStateV1 | null): boolean {
  const encode = (value: PanelOpaqueStateV1 | null) => JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  return encode(first) === encode(second);
}

export function parseCompositionLayout(value: unknown): CompositionLayoutV1 {
  const input = record(jsonCopy(value, layoutBytes));
  fields(input, ['version', 'compositionId', 'revision', 'instances', 'columns']);
  if (input.version !== 1 || !isSlotId(input.compositionId) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0
    || !Array.isArray(input.instances) || input.instances.length > maxInstances || !Array.isArray(input.columns) || input.columns.length > 8) invalid('Invalid composition layout.');
  const ids = new Set<string>();
  const instances: PanelLayoutInstanceV1[] = input.instances.map(item => {
    const instance = record(item); fields(instance, ['instanceId', 'contributionId', 'hidden', 'scope', 'state']);
    if (typeof instance.instanceId !== 'string' || !instanceIdPattern.test(instance.instanceId) || ids.has(instance.instanceId)
      || !isContributionId(instance.contributionId) || typeof instance.hidden !== 'boolean') invalid('Invalid or duplicate panel instance.');
    ids.add(instance.instanceId);
    return { instanceId: instance.instanceId, contributionId: instance.contributionId, hidden: instance.hidden, scope: scope(instance.scope), state: states(instance.state) };
  });
  const placed = new Set<string>();
  let stacks = 0;
  const columns = input.columns.map(column => {
    if (!Array.isArray(column) || column.length > maxInstances) invalid('Invalid layout column.');
    return column.map(item => {
      const stack = record(item); fields(stack, ['instances', 'activeInstanceId', 'collapsed']);
      if (++stacks > maxInstances || !Array.isArray(stack.instances) || !stack.instances.length || stack.instances.length > maxInstances
        || typeof stack.activeInstanceId !== 'string' || !stack.instances.includes(stack.activeInstanceId) || typeof stack.collapsed !== 'boolean') invalid('Invalid panel stack.');
      for (const id of stack.instances) {
        if (typeof id !== 'string' || !ids.has(id) || placed.has(id)) invalid('A panel instance must have exactly one stack.');
        placed.add(id);
      }
      return { instances: stack.instances as string[], activeInstanceId: stack.activeInstanceId, collapsed: stack.collapsed };
    });
  });
  if (placed.size !== ids.size) invalid('A panel instance is missing its stack.');
  return { version: 1, compositionId: input.compositionId, revision: input.revision as number, instances, columns };
}

export interface LegacyCompositionLayoutInput {
  readonly rackRaw: string | null;
  readonly scopesRaw?: string | null;
  readonly stateRaw?: string | null;
  readonly contributionIds?: Readonly<Record<string, string>>;
}
const legacyPanels = new Set(['newrun', 'backlog', 'underway', 'running', 'recent', 'repoprs', 'shipped', 'activity']);
function rawJson(raw: string): unknown {
  if (raw.length > layoutBytes) invalid('Legacy layout is too large.');
  try { return jsonCopy(JSON.parse(raw), layoutBytes); } catch (error) {
    if (error instanceof CompositionLayoutValidationError) throw error;
    return invalid('Legacy layout is not valid JSON.');
  }
}

export function migrateLegacyCompositionLayout(initial: CompositionLayoutV1, legacy: LegacyCompositionLayoutInput): CompositionLayoutV1 {
  const base = parseCompositionLayout(initial);
  if (legacy.rackRaw === null) return { ...base, revision: 1 };
  const rack = rawJson(legacy.rackRaw);
  if (!Array.isArray(rack) || rack.length > 8) invalid('Invalid legacy rack layout.');
  const savedScopes = legacy.scopesRaw == null ? {} : record(rawJson(legacy.scopesRaw));
  const savedStates = legacy.stateRaw == null ? {} : record(rawJson(legacy.stateRaw));
  const instances: PanelLayoutInstanceV1[] = [];
  const columns: PanelLayoutStackV1[][] = rack.map((column, columnIndex) => {
    if (!Array.isArray(column) || column.length > maxInstances) invalid('Invalid legacy layout column.');
    return column.map((item, stackIndex) => {
      const slot = record(item);
      if (!Array.isArray(slot.panels) || !slot.panels.length || slot.panels.length > maxInstances) invalid('Invalid legacy panel stack.');
      const stackIds = slot.panels.map((panel, panelIndex) => {
        if (typeof panel !== 'string' || !panel || panel.length > 512 || instances.length >= maxInstances) invalid('Invalid legacy panel identity.');
        const normalized = panel === 'myprs' ? 'repoprs' : panel;
        const instanceId = `legacy-${columnIndex}-${stackIndex}-${panelIndex}`;
        const mapped = Object.hasOwn(legacy.contributionIds ?? {}, normalized) ? legacy.contributionIds?.[normalized] : undefined;
        const contributionId = mapped ?? (legacyPanels.has(normalized) ? `helmsman.${normalized}/panel`
          : isContributionId(normalized) ? normalized : `helmsman.unavailable/${instanceId}`);
        const rawScope = Object.hasOwn(savedScopes, panel) ? savedScopes[panel] : { kind: 'inherit' };
        const panelScope = typeof rawScope === 'string' ? { kind: 'galleon' as const, repo: rawScope } : rawScope === null ? { kind: 'all' as const } : scope(rawScope);
        const state = Object.hasOwn(savedStates, panel) ? states(savedStates[panel]) : {};
        instances.push({ instanceId, contributionId, hidden: false, scope: panelScope, state });
        return instanceId;
      });
      const activeIndex = slot.panels.findIndex(panel => panel === slot.active || panel === 'myprs' && slot.active === 'repoprs');
      return { instances: stackIds, activeInstanceId: stackIds[Math.max(0, activeIndex)]!, collapsed: slot.collapsed === true };
    });
  });
  return parseCompositionLayout({ ...base, revision: 1, instances, columns });
}

export interface CompositionLayoutStore {
  read(): Promise<CompositionLayoutV1>;
  update(layout: CompositionLayoutV1, expectedRevision: number, signal?: AbortSignal): Promise<CompositionLayoutV1>;
  subscribe(listener: () => void): () => void;
  close(): void;
}
interface LayoutChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}
export interface CompositionLayoutStoreOptions {
  readonly compositionId: string;
  readonly initialLayout: CompositionLayoutV1;
  readonly legacy?: LegacyCompositionLayoutInput;
  readonly initialize?: (layout: CompositionLayoutV1) => {
    readonly layout: CompositionLayoutV1;
    readonly archive: { readonly version: number; readonly raw: Readonly<Record<string, string | null>> };
  };
  readonly indexedDB?: IDBFactory;
  readonly databaseName?: string;
  readonly channelFactory?: (name: string) => LayoutChannel;
}

export async function openCompositionLayoutStore(options: CompositionLayoutStoreOptions): Promise<CompositionLayoutStore> {
  const initial = parseCompositionLayout(options.initialLayout);
  if (initial.compositionId !== options.compositionId) invalid('Initial layout belongs to another composition.');
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('Browser layout storage is unavailable.');
  const name = options.databaseName ?? 'helmsman.composition-layouts';
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      for (const store of ['layouts', 'migrations']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'compositionId' });
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to open browser layout storage.'));
    request.onblocked = () => { rejected = true; reject(new Error('Browser layout storage is blocked by another window.')); };
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
  });
  let closed = false;
  const listeners = new Set<() => void>();
  function transaction<T>(mode: IDBTransactionMode, execute: (tx: IDBTransaction, done: (result: T) => void, fail: (error: unknown) => void) => void, signal?: AbortSignal): Promise<T> {
    if (closed) return Promise.reject(new Error('Composition layout storage is closed.'));
    return new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted();
      const tx = database.transaction(['layouts', 'migrations'], mode);
      let result: T; let failure: unknown;
      const cancel = () => { failure = signal?.reason ?? new DOMException('Layout update cancelled.', 'AbortError'); try { tx.abort(); } catch { return; } };
      tx.oncomplete = () => { signal?.removeEventListener('abort', cancel); resolve(result); };
      tx.onabort = () => { signal?.removeEventListener('abort', cancel); reject(failure ?? tx.error ?? new Error('Layout transaction was aborted.')); };
      tx.onerror = () => { failure ??= tx.error; };
      signal?.addEventListener('abort', cancel, { once: true });
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      try { execute(tx, value => { result = value; }, fail); } catch (error) { fail(error); }
    });
  }
  try {
    await transaction<void>('readwrite', (tx, done, fail) => {
      const table = tx.objectStore('layouts'); const read = table.get(options.compositionId);
      read.onsuccess = () => {
        try {
          if (read.result !== undefined) { parseCompositionLayout(read.result); done(); return; }
          if (options.legacy && options.initialize) invalid('Conflicting layout initializers.');
          const initialized = options.initialize?.(parseCompositionLayout(initial));
          const layout = initialized ? parseCompositionLayout({ ...initialized.layout, revision: 1 })
            : options.legacy ? migrateLegacyCompositionLayout(initial, options.legacy) : { ...initial, revision: 1 };
          if (layout.compositionId !== options.compositionId) invalid('Initialized layout belongs to another composition.');
          if (initialized) {
            const archive = record(jsonCopy(initialized.archive, layoutBytes)); fields(archive, ['version', 'raw']);
            const raw = record(archive.raw);
            if (!Number.isSafeInteger(archive.version) || (archive.version as number) < 1 || Object.keys(raw).length > 128
              || Object.entries(raw).some(([key, value]) => !key || key.length > 512 || value !== null && typeof value !== 'string')) invalid('Invalid layout migration archive.');
            tx.objectStore('migrations').add({ ...archive, compositionId: options.compositionId });
          } else if (options.legacy) tx.objectStore('migrations').add({ compositionId: options.compositionId, version: 1,
            rackRaw: options.legacy.rackRaw, scopesRaw: options.legacy.scopesRaw ?? null, stateRaw: options.legacy.stateRaw ?? null });
          table.add(layout); done();
        } catch (error) { fail(error); }
      };
    });
  } catch (error) { database.close(); throw error; }
  let channel: LayoutChannel | null = null;
  try { channel = options.channelFactory ? options.channelFactory(name) : typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null; } catch { channel = null; }
  function notify(): void { for (const listener of [...listeners]) { try { listener(); } catch { continue; } } }
  const receive = (event: MessageEvent) => {
    const data = event?.data as { compositionId?: unknown; revision?: unknown } | null;
    if (!closed && data?.compositionId === options.compositionId && Number.isSafeInteger(data.revision) && (data.revision as number) > 0) notify();
  };
  channel?.addEventListener('message', receive);
  const close = () => { if (closed) return; closed = true; listeners.clear(); channel?.removeEventListener('message', receive); channel?.close(); database.close(); };
  database.onversionchange = close;
  return {
    read: () => transaction<CompositionLayoutV1>('readonly', (tx, done, fail) => {
      const request = tx.objectStore('layouts').get(options.compositionId);
      request.onsuccess = () => { try { done(parseCompositionLayout(request.result)); } catch (error) { fail(error); } };
    }),
    async update(value, expectedRevision, signal) {
      signal?.throwIfAborted();
      const next = parseCompositionLayout(value);
      if (next.compositionId !== options.compositionId || next.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision === Number.MAX_SAFE_INTEGER) invalid('Invalid layout update revision or composition.');
      const saved = await transaction<CompositionLayoutV1>('readwrite', (tx, done, fail) => {
        const table = tx.objectStore('layouts'); const request = table.get(options.compositionId);
        request.onsuccess = () => {
          try {
            const previous = parseCompositionLayout(request.result);
            if (previous.revision !== expectedRevision) throw new CompositionLayoutConflictError('Layout changed in another view. Reload it before saving.');
            const updated = { ...next, revision: expectedRevision + 1 }; table.put(updated); done(updated);
          } catch (error) { fail(error); }
        };
      }, signal);
      if (!closed) {
        notify();
        try { channel?.postMessage({ compositionId: options.compositionId, revision: saved.revision }); } catch { /* The committed layout remains readable when notification transport closes. */ }
      }
      return saved;
    },
    subscribe(listener) {
      if (closed) throw new Error('Composition layout storage is closed.');
      if (typeof listener !== 'function') throw new TypeError('Layout listener must be a function.');
      const subscription = () => listener(); listeners.add(subscription); return () => { listeners.delete(subscription); };
    },
    close,
  };
}

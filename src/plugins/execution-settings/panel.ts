import type { ExecutionPolicyCommandV1, ExecutionPolicySnapshotV1, PluginPanelModule } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';

function savedCommand(value: unknown): ExecutionPolicyCommandV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved request');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.repo !== 'string' || !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(input.repo)
    || typeof input.requestId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(input.requestId)
    || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
    || !Number.isSafeInteger(input.maxConcurrentRuns) || Number(input.maxConcurrentRuns) < 1 || Number(input.maxConcurrentRuns) > 20
    || Object.keys(input).some(key => !['version', 'repo', 'requestId', 'expectedRevision', 'maxConcurrentRuns'].includes(key))) throw new Error('Invalid saved request');
  return { version: 1, repo: input.repo.toLowerCase(), requestId: input.requestId, expectedRevision: Number(input.expectedRevision), maxConcurrentRuns: Number(input.maxConcurrentRuns) };
}

const panel: PluginPanelModule = { mount(container, context) {
  const service = context.services.executionPolicy;
  if (!service) throw new Error('Execution settings requires its public policy service');
  let state = context.state; let snapshot: ExecutionPolicySnapshotV1 | null = null; let pending: ExecutionPolicyCommandV1 | null = null;
  let generation = 0; let disposed = false; let busy = false; let message = ''; let storageError = false; let conflicted = false;
  let selected = 1; let confirmed = false;
  const key = (repo: string) => `helmsman.execution-policy.v1:${context.contributionId}:${state.instanceId}:${repo.toLowerCase()}`;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
  function restore() {
    pending = null; storageError = false; conflicted = false;
    if (!state.repo) return;
    try { const raw = localStorage.getItem(key(state.repo)); if (raw) { const value = savedCommand(JSON.parse(raw)); if (value.repo !== state.repo.toLowerCase()) throw new Error('Scope changed'); pending = value; } }
    catch { storageError = true; message = 'The saved request could not be read. No changes can be sent until local storage is available.'; }
  }
  function button(text: string, action: () => void, disabled = false) { const value = node('button', text); value.type = 'button'; value.disabled = disabled; value.addEventListener('click', action); return value; }
  function draw() {
    if (disposed) return;
    const root = node('section'); root.className = 'execution-settings'; root.append(node('style', styles), node('h2', 'Execution settings'));
    if (!state.repo) root.append(node('p', `Select a ${state.pirateMode ? 'galleon' : 'repository'} to configure parallel runs.`));
    else {
      root.append(node('p', `Scope: ${state.repo}`));
      if (!snapshot) root.append(node('p', 'Execution settings are unavailable until this installation can safely manage parallel runs.'));
      else {
        const { policy, limits, readiness } = snapshot;
        root.append(node('p', `${limits.activeRuns} active runs in this ${state.pirateMode ? 'galleon' : 'repository'}. Global limit: ${limits.globalMaxConcurrentRuns}. Current local limit: ${policy.maxConcurrentRuns}.`));
        root.append(node('p', limits.perRunCostCapUsd === null ? 'No per-run cost cap is configured.' : `Per-run cost cap: $${limits.perRunCostCapUsd.toFixed(2)}.`));
        const parallelReady = readiness.currentVersion === 2 && readiness.ready;
        if (!parallelReady) {
          root.append(node('p', 'Parallel runs are blocked until retained executions and plugins support safe shared ownership. Settle the listed obligations, then restart to recheck.'));
          const blockers = node('ul'); for (const item of readiness.blockers) blockers.append(node('li', `${item.source}: ${item.identity} (supports ownership versions ${item.range.minimum}–${item.range.maximum})`)); root.append(blockers);
        }
        const label = node('label', 'Maximum simultaneous runs here'); const maximum = node('input'); maximum.type = 'number'; maximum.min = '1'; maximum.max = '20'; maximum.step = '1'; maximum.value = String(selected);
        maximum.disabled = busy || !!pending || storageError; maximum.addEventListener('change', () => { selected = Number(maximum.value); confirmed = false; draw(); }); label.append(maximum); root.append(label);
        if (selected > 1) {
          root.append(node('p', `This allows up to ${Math.min(selected, limits.globalMaxConcurrentRuns)} simultaneous runs here, within the global limit. Each run uses its own cost cap. Shared tickets, branches and pull requests remain reserved.`));
          const consent = node('label'); const check = node('input'); check.type = 'checkbox'; check.checked = confirmed; check.disabled = busy || !!pending;
          check.addEventListener('change', () => { confirmed = check.checked; draw(); }); consent.append(check, document.createTextNode(' Enable parallel runs with these limits')); root.append(consent);
        }
        root.append(button(pending ? 'Retry saved change' : 'Save execution settings', () => { void save(); }, busy || storageError || !pending && (!Number.isSafeInteger(selected) || selected < 1 || selected > 20 || selected > 1 && (!parallelReady || !confirmed))));
        if (pending) root.append(node('p', `Saved request: limit ${pending.maxConcurrentRuns}, based on revision ${pending.expectedRevision}. Retry checks the same request without applying it twice.`));
        if (pending && conflicted) root.append(button('Discard conflicted request', () => { try { localStorage.removeItem(key(pending!.repo)); restore(); message = ''; void read(); } catch { storageError = true; draw(); } }, busy));
      }
      root.append(button('Refresh', () => { void read(); }, busy));
    }
    if (message) { const status = node('p', message); status.setAttribute('role', 'alert'); root.append(status); }
    container.replaceChildren(root);
  }
  async function read() {
    if (busy) return;
    const repo = state.repo; const current = ++generation; snapshot = null; confirmed = false; restore(); draw();
    if (!repo || !state.visible || !state.activity.active) return;
    try {
      const result = await service!.read({ version: 1, repo });
      if (disposed || current !== generation) return;
      if (result.status === 'available') { snapshot = result.value; selected = pending?.maxConcurrentRuns ?? snapshot.policy.maxConcurrentRuns; if (!storageError) message = ''; }
      else message = `Execution settings are unavailable (${result.reason}).`;
    } catch { if (!disposed && current === generation) message = 'Execution settings could not be loaded.'; }
    if (!disposed && current === generation) draw();
  }
  async function save() {
    if (busy || storageError || !snapshot || !state.repo || !state.visible || !state.activity.active) return;
    const repo = state.repo; const current = generation;
    if (!pending && selected > 1 && (!confirmed || snapshot.readiness.currentVersion !== 2 || !snapshot.readiness.ready)) return;
    try {
      if (!pending) {
        pending = savedCommand({ version: 1, repo, requestId: crypto.randomUUID(), expectedRevision: snapshot.policy.revision, maxConcurrentRuns: selected });
        localStorage.setItem(key(repo), JSON.stringify(pending));
      }
    } catch { pending = null; storageError = true; message = 'The request could not be saved locally. No change was sent.'; draw(); return; }
    const request = pending; busy = true; message = ''; draw();
    try {
      const result = await service!.set(request);
      if (disposed || current !== generation) return;
      if (result.status === 'available') { localStorage.removeItem(key(repo)); pending = null; message = 'Execution settings saved.'; snapshot = { ...snapshot!, policy: result.value }; confirmed = false; }
      else { conflicted = result.reason === 'conflict'; message = conflicted ? 'The policy changed. Refresh, discard this conflicted request, and review the limits again.' : 'Delivery could not be confirmed. Retry the saved request to check its result.'; }
    } catch { if (!disposed && current === generation) message = 'Delivery could not be confirmed. Retry the saved request.'; }
    finally { if (!disposed && current === generation) { busy = false; draw(); } }
  }
  function dispose() { if (disposed) return; disposed = true; ++generation; context.signal.removeEventListener('abort', dispose); }
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose(); else void read();
  return { update(next) { const changed = next.repo !== state.repo || next.activity.epoch !== state.activity.epoch || next.visible !== state.visible; state = next; if (changed) { busy = false; void read(); } else draw(); }, refresh: read, dispose };
} };
export default panel;

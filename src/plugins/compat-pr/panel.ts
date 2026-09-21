import type { PluginPanelModule } from '../sdk';
import { findPrCompatibilitySession, prTarget, type PrIdentity } from '../../pr-compatibility-session';
import { parsePrUrl } from '../../data/pr';
import { renderPrPanel, renderPrDiff } from '../../render';
import { term } from '../../logic/terminology';

const validTarget = (value: unknown): PrIdentity | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PrIdentity>;
  return typeof item.repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(item.repo) && Number.isSafeInteger(item.number) && Number(item.number) > 0 ? { repo: item.repo, number: Number(item.number) } : null;
};
const identity = (target: PrIdentity | null) => target ? JSON.stringify([target.repo, target.number]) : '';
const panel: PluginPanelModule = { mount(container, context) {
  const session = findPrCompatibilitySession(container);
  if (!session) throw new Error('Pull request compatibility requires its private host session.');
  const owner = {}; let state = context.state; let disposed = false; let generation = 0; let loading = false; let error = ''; let lookup = '';
  let target = validTarget(state.presentation?.kind === 'pull-request' ? state.presentation : state.savedState?.version === 1 && state.savedState.value && typeof state.savedState.value === 'object' && !Array.isArray(state.savedState.value) ? (state.savedState.value as Record<string, unknown>).target : null);
  let routed = identity(state.presentation?.kind === 'pull-request' ? state.presentation : null);
  const active = () => !disposed && !context.signal.aborted && state.visible && state.activity.active && !state.activity.signal.aborted;
  const cancel = () => { ++generation; session.setActive(owner, false); loading = false; };
  function draw() {
    if (disposed) return;
    const focus = session!.capture(container);
    const lookupFocused = document.activeElement === container.querySelector('[data-pr-compat-lookup]');
    const root = document.createElement('section');
    const label = document.createElement('label'); label.textContent = `${term('pr')} URL or owner/name#number`;
    const input = document.createElement('input'); input.dataset.prCompatLookup = ''; input.value = lookup; input.setAttribute('aria-label', `${term('pr')} URL or owner/name#number`);
    input.addEventListener('input', () => { lookup = input.value; });
    const load = document.createElement('button'); load.type = 'button'; load.textContent = `Load ${term('pr')}`; load.disabled = !active();
    const select = () => {
      if (!active()) return;
      const parsed = validTarget(parsePrUrl(input.value));
      if (!parsed) { error = term('prLookupInvalid'); draw(); return; }
      cancel(); target = parsed; error = ''; session!.setActive(owner, active());
      void context.saveState({ version: 1, value: { target: { ...parsed } } }).catch(() => { if (!disposed) { error = 'The selected pull request could not be saved. It remains open here.'; draw(); } });
      void refresh();
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); select(); } });
    load.addEventListener('click', select); label.append(input); root.append(label, load);
    if (error || loading) { const message = document.createElement('p'); message.textContent = error || 'Loading pull request…'; message.setAttribute('role', error ? 'alert' : 'status'); root.append(message); }
    if (target) {
      const body = document.createElement('div'); body.innerHTML = renderPrPanel(session!.status(target), session!.canLaunch(target.repo), false, session!.headerRepo()) + renderPrDiff(session!.diff(target)); root.append(body);
    }
    container.replaceChildren(root); session!.restore(container, focus); session!.paintSlack(container, session!.slackEnabled());
    if (!active()) container.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
    if (lookupFocused) input.focus({ preventScroll: true });
  }
  async function refresh() {
    if (!active()) return;
    session!.setActive(owner, true);
    if (!target) { draw(); return; }
    const current = ++generation; const selected = target; loading = true; draw();
    await Promise.all([session!.readStatus(owner, selected), session!.readDiff(owner, selected)]);
    if (active() && current === generation) { loading = false; draw(); }
  }
  const capture = () => session.capture(container);
  const clicked = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    event.stopPropagation();
    const link = element.closest<HTMLAnchorElement>('a.app-link');
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); context.navigate(link.getAttribute('href') ?? '/prs'); return; }
    const button = element.closest<HTMLButtonElement>('button');
    if (!button || button.disabled || !active()) return;
    const selected = prTarget(button); if (!selected) return;
    if (button.matches('[data-slack-review-request]')) { void session.requestSlack(owner, selected); return; }
    const review = button.matches('.pr-approve') ? 'APPROVE' : button.matches('.pr-request-changes') ? 'REQUEST_CHANGES' : button.matches('.pr-comment') ? 'COMMENT' : null;
    if (review) { button.disabled = true; void session.review(owner, selected, review).then(() => { if (active()) draw(); }); return; }
    const mode = button.matches('.pr-rerun') ? 'rerun' : button.matches('.pr-review-agent') ? 'review' : null;
    if (mode) {
      const current = generation; button.disabled = true;
      void session.launch(owner, selected, mode).then(outcome => {
        if (!active() || current !== generation) return;
        if (outcome?.result) context.navigate(`/runs?${new URLSearchParams({ ...(session.headerRepo() ? { repo: session.headerRepo()! } : {}), run: outcome.result.runId, runRepo: selected.repo })}`);
        else { error = outcome?.error ?? ''; draw(); }
      });
    }
  };
  const unsubscribe = session.subscribe(() => { if (active()) draw(); });
  function dispose() {
    if (disposed) return; session!.capture(container); cancel(); disposed = true; unsubscribe();
    state.activity.signal.removeEventListener('abort', cancel); context.signal.removeEventListener('abort', dispose);
    container.removeEventListener('click', clicked); container.removeEventListener('input', capture); container.removeEventListener('change', capture);
  }
  container.addEventListener('click', clicked); container.addEventListener('input', capture); container.addEventListener('change', capture);
  state.activity.signal.addEventListener('abort', cancel, { once: true }); context.signal.addEventListener('abort', dispose, { once: true }); context.onDispose(dispose);
  session.setActive(owner, active()); if (context.signal.aborted) dispose(); else { draw(); void refresh(); }
  return { update(next) {
    if (disposed) return;
    session!.capture(container); const previous = state; state = next;
    const nextRoute = identity(next.presentation?.kind === 'pull-request' ? next.presentation : null);
    const changed = previous.activity !== next.activity || previous.visible !== next.visible || nextRoute !== routed;
    if (changed) {
      previous.activity.signal.removeEventListener('abort', cancel); cancel();
      if (nextRoute !== routed) { routed = nextRoute; if (next.presentation?.kind === 'pull-request') target = validTarget(next.presentation); }
      state.activity.signal.addEventListener('abort', cancel, { once: true }); session!.setActive(owner, active());
    }
    draw(); if (changed) return refresh();
  }, refresh, dispose };
} };
export default panel;

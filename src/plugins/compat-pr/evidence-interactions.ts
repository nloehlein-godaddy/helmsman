export function attachEvidenceInteractions(container: HTMLElement, signal: AbortSignal): () => void {
  const pinned = new WeakSet<HTMLDetailsElement>(); const hovered = new WeakSet<HTMLDetailsElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const popup = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLDetailsElement>('.pr-stat-preview') : null;
  const close = (details: HTMLDetailsElement) => { details.open = false; pinned.delete(details); hovered.delete(details); };
  const open = (details: HTMLDetailsElement) => { details.dataset.align = details.getBoundingClientRect().left + 340 > window.innerWidth - 24 ? 'end' : 'start'; details.open = true; };
  const closeOthers = (except?: HTMLDetailsElement) => { for (const details of container.querySelectorAll<HTMLDetailsElement>('.pr-stat-preview[open]')) if (details !== except) close(details); };
  const over = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return; const details = popup(event.target); if (!details || !container.contains(details)) return;
    clearTimeout(timer); hovered.add(details); closeOthers(details); open(details);
  };
  const out = (event: PointerEvent) => {
    const details = popup(event.target); if (!details || event.relatedTarget instanceof Node && details.contains(event.relatedTarget)) return;
    hovered.delete(details); clearTimeout(timer);
    timer = setTimeout(() => { if (details.isConnected && !pinned.has(details) && !details.contains(document.activeElement)) close(details); }, 120);
  };
  const focus = (event: FocusEvent) => { const details = popup(event.target); if (details) { closeOthers(details); open(details); } };
  const blur = (event: FocusEvent) => {
    const details = popup(event.target); if (!details || event.relatedTarget instanceof Node && details.contains(event.relatedTarget) || hovered.has(details)) return;
    close(details);
  };
  const click = (event: MouseEvent) => {
    const summary = event.target instanceof Element ? event.target.closest('summary') : null; const details = popup(summary);
    if (!details || summary?.parentElement !== details) return; event.preventDefault();
    if (pinned.has(details)) close(details); else { closeOthers(details); pinned.add(details); open(details); }
  };
  const outside = (event: PointerEvent) => { if (!(event.target instanceof Node) || !container.contains(event.target) || !popup(event.target)) closeOthers(); };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return; const details = popup(event.target) ?? container.querySelector<HTMLDetailsElement>('.pr-stat-preview[open]');
    if (!details) return; event.preventDefault(); close(details); details.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true }); details.open = false;
  };
  const dispose = () => {
    clearTimeout(timer); container.removeEventListener('pointerover', over); container.removeEventListener('pointerout', out); container.removeEventListener('focusin', focus); container.removeEventListener('focusout', blur); container.removeEventListener('click', click); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); signal.removeEventListener('abort', dispose); closeOthers();
  };
  container.addEventListener('pointerover', over); container.addEventListener('pointerout', out); container.addEventListener('focusin', focus); container.addEventListener('focusout', blur); container.addEventListener('click', click); document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose(); return dispose;
}

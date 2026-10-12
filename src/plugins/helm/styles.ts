export const styles = `
.plugin-helm {font:16px/1.5 var(--sans,sans-serif);color:var(--text);display:grid;gap:16px;min-width:0}
.plugin-helm h1 {font-size:22px;font-weight:650;margin:0}.plugin-helm h2 {font-size:17px;margin:0}
.plugin-helm .helm-tools,.plugin-helm .helm-config-row {display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.plugin-helm .helm-tools {justify-content:space-between}.plugin-helm .composition-page-actions {display:flex;align-items:center;gap:8px}.plugin-helm .composition-page-editor[hidden] {display:none}.plugin-helm .helm-columns {display:grid;grid-template-columns:repeat(var(--helm-columns,2),minmax(0,1fr));gap:16px;align-items:start}
.plugin-helm .composition-icon-button {display:inline-grid;place-items:center;width:36px;height:36px;min-width:36px;min-height:36px;padding:7px}.plugin-helm .composition-icon-button svg {width:18px;height:18px}.plugin-helm .composition-page-edit[aria-pressed=true] {border-color:var(--accent);color:var(--accent-text,var(--accent))}
.plugin-helm .helm-column {display:grid;gap:16px;min-width:0}.plugin-helm .helm-stack {border:1px solid var(--line);border-radius:12px;background:var(--panel);min-width:0;overflow:hidden}
.plugin-helm .helm-stack-header {display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--line);min-width:0}
.plugin-helm .helm-stack-header .helm-tabs {flex:1}
.plugin-helm .helm-grip {cursor:grab;touch-action:none;flex:none;background:transparent;border-color:transparent;color:var(--text-dim)}
.plugin-helm .helm-grip[aria-pressed=true] {cursor:grabbing;color:var(--accent-text,var(--accent))}
.plugin-helm .helm-stack {position:relative}
.plugin-helm .helm-dragging {opacity:.65;border-color:var(--accent-text,var(--accent))}
.plugin-helm :is(.helm-drop-before,.helm-drop-after)::after {content:'';position:absolute;left:0;right:0;height:3px;background:var(--accent-text,var(--accent));pointer-events:none;z-index:1}
.plugin-helm .helm-drop-before::after {top:0}.plugin-helm .helm-drop-after::after {bottom:0}
.plugin-helm .helm-drop-column {outline:2px solid var(--accent-text,var(--accent));outline-offset:3px;min-height:72px}
.plugin-helm .helm-column:empty {min-height:72px}
.plugin-helm .helm-empty-target {display:none;min-height:72px;place-items:center;border:1px dashed var(--line-strong);border-radius:12px;color:var(--text-dim);font-size:12px}
.plugin-helm.helm-moving .helm-empty-target {display:grid}
.plugin-helm .helm-sr-only {position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.plugin-helm .helm-tabs {display:flex;gap:4px;min-width:0;overflow-x:auto;align-items:center}.plugin-helm .helm-tabs button {flex-shrink:0;background:transparent;border-color:transparent;color:var(--text-dim);font-size:15px;font-weight:600}
.plugin-helm .helm-tabs [aria-selected=true] {background:var(--accent-plate);color:var(--on-accent,var(--face-hi))}
.plugin-helm .helm-tabs button:only-child {background:transparent;color:var(--text);padding-inline:0;border-color:transparent}
.plugin-helm .helm-collapse {display:grid;place-items:center;width:32px;height:32px;min-height:32px;padding:6px;flex-shrink:0;background:transparent;border-color:transparent;color:var(--text-dim)}
.plugin-helm .helm-collapse svg {width:16px;height:16px;transition:transform 160ms ease}.plugin-helm .helm-collapse[aria-expanded=false] svg {transform:rotate(-90deg)}
.plugin-helm .helm-panel-body {padding:16px;min-width:0}.plugin-helm .helm-panel-body[hidden] {display:none}
.plugin-helm button,.plugin-helm select,.plugin-helm input {font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;max-width:100%;min-height:34px;box-sizing:border-box}.plugin-helm :is(input,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-helm button {cursor:pointer}.plugin-helm button:not(:disabled):hover {border-color:var(--accent)}.plugin-helm button:disabled {opacity:.5;cursor:not-allowed}.plugin-helm label {display:flex;gap:8px;align-items:center}
.plugin-helm .composition-page-editor {padding:12px 0;border-top:1px solid var(--line)}.plugin-helm .helm-config {display:grid;gap:12px}
.plugin-helm .helm-config-row {padding-bottom:12px;border-bottom:1px solid var(--line)}.plugin-helm .helm-config-row strong {overflow-wrap:anywhere}
.plugin-helm [role=alert] {color:var(--bad)}.plugin-helm :is(button,select,input,summary):focus-visible {outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:760px) {.plugin-helm .helm-columns {grid-template-columns:1fr}.plugin-helm .helm-panel-body {padding:12px}}
@media(any-pointer:coarse) {.plugin-helm :is(button,select,input,summary) {min-height:44px;min-width:44px}.plugin-helm .helm-collapse,.plugin-helm .composition-icon-button {width:44px;height:44px}}
@media(prefers-reduced-motion:reduce) {.plugin-helm .helm-collapse svg {transition:none}}
`;

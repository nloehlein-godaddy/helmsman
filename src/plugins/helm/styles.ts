export const styles = `
.plugin-helm {font:14px var(--sans,sans-serif);color:var(--text);display:grid;gap:16px;min-width:0}
.plugin-helm h1 {font-size:18px;margin:0}.plugin-helm h2 {font-size:14px;margin:0}
.plugin-helm .helm-tools,.plugin-helm .helm-tabs,.plugin-helm .helm-config-row {display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.plugin-helm .helm-tools {justify-content:space-between}.plugin-helm .helm-columns {display:grid;grid-template-columns:repeat(var(--helm-columns,2),minmax(0,1fr));gap:16px;align-items:start}
.plugin-helm .helm-column {display:grid;gap:16px;min-width:0}.plugin-helm .helm-stack {border:1px solid var(--line);border-radius:var(--radius,4px);background:var(--panel);min-width:0;overflow:hidden}
.plugin-helm .helm-tabs {padding:10px;border-bottom:1px solid var(--line)}.plugin-helm .helm-tabs [aria-selected=true] {background:var(--accent-plate);color:var(--face-hi)}
.plugin-helm .helm-panel-body {padding:12px;min-width:0}.plugin-helm .helm-panel-body[hidden] {display:none}
.plugin-helm button,.plugin-helm select,.plugin-helm input {font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:var(--radius,4px);padding:6px 9px;max-width:100%}.plugin-helm :is(input,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-helm button {cursor:pointer}.plugin-helm button:disabled {opacity:.5;cursor:default}.plugin-helm label {display:flex;gap:6px;align-items:center}
.plugin-helm details {border:1px solid var(--line);border-radius:var(--radius,4px);padding:10px}.plugin-helm summary {cursor:pointer}.plugin-helm .helm-config {display:grid;gap:12px;margin-top:12px}
.plugin-helm .helm-config-row {padding-bottom:10px;border-bottom:1px solid var(--line)}.plugin-helm .helm-config-row strong {overflow-wrap:anywhere}
.plugin-helm [role=alert] {color:var(--bad)}.plugin-helm :is(button,select,input,summary):focus-visible {outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:760px) {.plugin-helm .helm-columns {grid-template-columns:1fr}}
`;

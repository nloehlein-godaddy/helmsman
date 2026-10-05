export const styles = `
.plugin-run-viewer{color:var(--text);font:14px var(--sans,sans-serif);min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;overflow-wrap:anywhere}
.plugin-run-viewer :is(h1,h2,h3,p){margin:0}
.plugin-run-viewer h1{font-size:18px}
.plugin-run-viewer :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:var(--radius,4px);padding:6px 10px}
.plugin-run-viewer select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-run-viewer button{cursor:pointer}
.plugin-run-viewer button:disabled{opacity:.5;cursor:default}
.plugin-run-viewer .run-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.plugin-run-viewer [role=alert]{color:var(--bad)}
.plugin-run-viewer small{color:var(--text-dim)}
.plugin-run-viewer :is(button,select):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-run-viewer section{min-width:0;display:grid;gap:10px}
.plugin-run-viewer .run-row{padding:12px 0;border-bottom:1px solid var(--line);display:grid;gap:7px;overflow-wrap:anywhere}
.plugin-run-viewer .run-log{box-sizing:border-box;max-height:420px;min-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px;background:var(--face);border:1px solid var(--line);font:12px/1.6 var(--mono,monospace)}
.plugin-run-viewer [aria-selected=true]{border-color:var(--accent);color:var(--accent)}
.plugin-run-viewer details[open]{display:grid;gap:10px}
.plugin-run-viewer .run-tab-status{display:block;font-size:10px;color:var(--text-dim)}
.plugin-run-viewer [data-run-status=succeeded] .run-tab-status{color:var(--good)}
.plugin-run-viewer [data-run-status=failed] .run-tab-status,.plugin-run-viewer .run-tab-status[data-review-outcome=REQUEST_CHANGES]{color:var(--bad)}
.plugin-run-viewer [data-run-status=running] .run-tab-status,.plugin-run-viewer .run-tab-status[data-review-outcome=COMMENT]{color:var(--review)}
.plugin-run-viewer .run-tab-status[data-feedback-outcome=changes_remaining]{color:var(--bad)}
.plugin-run-viewer .run-tab-status[data-feedback-outcome=awaiting_decision]{color:var(--review)}
.plugin-run-viewer .run-tabs{display:flex;align-items:stretch;gap:6px;overflow-x:auto;padding:6px;scrollbar-width:thin;border-bottom:1px solid var(--line);background:var(--face)}
.plugin-run-viewer .run-tab{display:flex;flex:0 0 270px;box-sizing:border-box;min-width:0;max-width:calc(100% - 12px);align-items:center;gap:3px;padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius,4px)}
.plugin-run-viewer [role=tab]{flex:1;min-width:0;max-width:none;padding:0;border:0;background:transparent;text-align:left;font:12px var(--mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plugin-run-viewer .run-tab-identity{display:block;overflow:hidden;text-overflow:ellipsis;font-size:10px}
.plugin-run-viewer .run-tab-open,.plugin-run-viewer .run-tab>button:not([role=tab]){display:inline-flex;align-items:center;justify-content:center;flex:none;width:25px;height:25px;padding:3px;color:var(--text-dim);text-decoration:none;border:1px solid transparent;background:transparent}
.plugin-run-viewer .run-tab:has([aria-selected=true]){border-color:var(--accent)}
.plugin-run-viewer .run-tab-open:hover,.plugin-run-viewer .run-tab>button:not([role=tab]):hover{color:var(--text);border-color:var(--line)}
.plugin-run-viewer .run-tab-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (height > 1500px) {
  .plugin-run-viewer .run-tabs{position:sticky;top:0;z-index:1}
}
`;

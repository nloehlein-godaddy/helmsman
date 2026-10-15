export const styles = `
.plugin-run-viewer{color:var(--text);font:16px var(--sans,sans-serif);min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;overflow-wrap:anywhere}
.plugin-run-viewer :is(h1,h2,h3,p){margin:0}
.plugin-run-viewer h1{font-size:20px}
.plugin-run-viewer :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px}
.plugin-run-viewer select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-run-viewer button{cursor:pointer}
.plugin-run-viewer button:disabled{opacity:.5;cursor:default}
.plugin-run-viewer .run-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.plugin-run-viewer [role=alert]{color:var(--bad)}
.plugin-run-viewer small{color:var(--text-dim)}
.plugin-run-viewer :is(button,select):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-run-viewer section{min-width:0;display:grid;gap:12px}
.plugin-run-viewer .run-row{padding:12px 0;border-bottom:1px solid var(--line);display:grid;gap:7px;overflow-wrap:anywhere}
.plugin-run-viewer .run-log{box-sizing:border-box;max-height:420px;min-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px;background:var(--face);border:1px solid var(--line);font:14px/1.6 var(--mono,monospace)}
.plugin-run-viewer [aria-selected=true]{border-color:var(--accent);color:var(--accent-text,var(--accent))}
.plugin-run-viewer details[open]{display:grid;gap:12px}
.plugin-run-viewer .run-tab-status{display:block;font-size: 14px;color:var(--text-dim)}
.plugin-run-viewer [data-run-status=succeeded] .run-tab-status{color:var(--good)}
.plugin-run-viewer [data-run-status=failed] .run-tab-status,.plugin-run-viewer .run-tab-status[data-review-outcome=REQUEST_CHANGES]{color:var(--bad)}
.plugin-run-viewer [data-run-status=running] .run-tab-status,.plugin-run-viewer .run-tab-status[data-review-outcome=COMMENT]{color:var(--review)}
.plugin-run-viewer .run-tab-status[data-feedback-outcome=changes_remaining]{color:var(--bad)}
.plugin-run-viewer .run-tab-status[data-feedback-outcome=awaiting_decision]{color:var(--review)}
.plugin-run-viewer .run-tabs{display:flex;align-items:stretch;gap:6px;overflow-x:auto;padding:6px;scrollbar-width:thin;border-bottom:1px solid var(--line);background:var(--face)}
.plugin-run-viewer .run-tab{display:flex;flex:0 0 270px;box-sizing:border-box;min-width:0;max-width:calc(100% - 12px);align-items:center;gap:3px;padding:6px 8px;border:1px solid var(--line);border-radius:6px}
.plugin-run-viewer [role=tab]{flex:1;min-width:0;max-width:none;padding:0;border:0;background:transparent;text-align:left;font:14px var(--mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plugin-run-viewer .run-tab-identity{display:block;overflow:hidden;text-overflow:ellipsis;font-size: 14px}
.plugin-run-viewer .run-tab-open,.plugin-run-viewer .run-tab>button:not([role=tab]){display:inline-flex;align-items:center;justify-content:center;flex:none;width:25px;height:25px;padding:3px;color:var(--text-dim);text-decoration:none;border:1px solid transparent;background:transparent}
.plugin-run-viewer .run-tab:has([aria-selected=true]){border-color:var(--accent)}
.plugin-run-viewer .run-tab-open:hover,.plugin-run-viewer .run-tab>button:not([role=tab]):hover{color:var(--text);border-color:var(--line)}
.plugin-run-viewer .run-tab-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (height > 1500px) {
  .plugin-run-viewer .run-tabs{position:sticky;top:0;z-index:1}

}
.plugin-run-viewer { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-run-viewer :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-run-viewer h1 { font-size: 26px; }
.plugin-run-viewer h2 { font-size: 20px; }
.plugin-run-viewer h3 { font-size: 18px; }
.plugin-run-viewer :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-run-viewer button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-run-viewer button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-run-viewer button:disabled { cursor: default; opacity: .5; }
.plugin-run-viewer :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-run-viewer :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-run-viewer :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-run-viewer small { font-size: 14px; }
.plugin-run-viewer p { max-width: 75ch; }
.plugin-run-viewer :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-run-viewer :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-run-viewer button { transition: none; }
 }
.plugin-run-viewer [role=tab] { font: 16px/1.4 var(--sans,sans-serif); padding: 0; }
.plugin-run-viewer .run-tab-identity { font: 14px/1.4 var(--mono,monospace); }
.plugin-run-viewer .run-tab { border-radius: 6px; padding: 8px 12px; }
.plugin-run-viewer .run-tab:has([aria-selected=true]) { background: color-mix(in srgb,var(--accent) 10%,var(--face)); }
.plugin-run-viewer .run-tab>button:not([role=tab]) { min-height: 32px; width: 32px; padding: 4px; }
.plugin-run-viewer .run-log { border-radius: 6px; }
.plugin-run-viewer [hidden] { display: none !important; }
.plugin-run-viewer .run-tabs:empty { display: none; }
.plugin-run-viewer .run-picker { padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.plugin-run-viewer .run-picker-list { display: grid; margin: 0; padding: 0; list-style: none; }
.plugin-run-viewer .run-picker-list>li+li { border-top: 1px solid var(--line-faint); }
.plugin-run-viewer .run-picker-row { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 100%; padding: 12px 8px; text-align: left; background: transparent; border: 0; }
.plugin-run-viewer .run-picker-row:hover:not(:disabled) { background: var(--panel-hi); }
.plugin-run-viewer .run-picker-title { font-weight: 600; }
.plugin-run-viewer .run-picker-meta { font-size: 14px; color: var(--text-dim); }
.plugin-run-viewer .run-picker-state { color: var(--text-dim); }
@media(any-pointer:coarse) {
  .plugin-run-viewer :is(button,select,summary) { min-height: 44px; min-width: 44px; }
  .plugin-run-viewer .run-tab-open,.plugin-run-viewer .run-tab>button:not([role=tab]) { width: 44px; height: 44px; min-height: 44px; box-sizing: border-box; }
}
`;

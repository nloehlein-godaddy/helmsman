export const styles = `
.plugin-runs{color:var(--text);font:16px var(--sans,sans-serif);min-width:0;display:grid;gap:12px}
.plugin-runs>h1{margin:0;font-size:20px}
.plugin-runs>.runs-tools,.plugin-runs>.runs-stack>.runs-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.plugin-runs .runs-tools>:is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;max-width:100%}
.plugin-runs .runs-tools>select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-runs .runs-tools>button{cursor:pointer;overflow-wrap:anywhere}
.plugin-runs .runs-tools>button:disabled{opacity:.5;cursor:default}
.plugin-runs .runs-tools>:is(button,select):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-runs>.runs-stack{min-width:0;display:grid;gap:12px}
.plugin-runs>.runs-stack>[data-panel-instance]{min-width:0}
.plugin-runs>[role=alert]{color:var(--bad)}
.plugin-runs>[role=status]{overflow-wrap:anywhere}
.plugin-runs { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-runs :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-runs h1 { font-size: 26px; }
.plugin-runs h2 { font-size: 20px; }
.plugin-runs h3 { font-size: 18px; }
.plugin-runs :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-runs button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-runs button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-runs button:disabled { cursor: default; opacity: .5; }
.plugin-runs :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-runs :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-runs :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-runs small { font-size: 14px; }
.plugin-runs p { max-width: 75ch; }
.plugin-runs :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-runs :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-runs button { transition: none; }
 }
`;

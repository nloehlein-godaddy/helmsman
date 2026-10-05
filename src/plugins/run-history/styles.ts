export const styles = `
.plugin-run-history{color:var(--text);font:14px var(--sans,sans-serif);min-width:0;display:grid;gap:12px}
.plugin-run-history :is(h1,h2,h3,p){margin:0}
.plugin-run-history h1{font-size:18px}
.plugin-run-history :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px}
.plugin-run-history select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-run-history button{cursor:pointer}
.plugin-run-history button:disabled{opacity:.5;cursor:default}
.plugin-run-history .run-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.plugin-run-history [role=alert]{color:var(--bad)}
.plugin-run-history a{color:var(--accent);text-underline-offset:3px}
.plugin-run-history .run-subject{font-weight:600}
.plugin-run-history small{color:var(--text-dim)}
.plugin-run-history :is(button,select,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-run-history section{min-width:0;display:grid;gap:12px}
.plugin-run-history .run-row{padding:12px 0;border-bottom:1px solid var(--line);display:grid;gap:7px;overflow-wrap:anywhere}
.plugin-run-history { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-run-history :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-run-history h1 { font-size: 24px; }
.plugin-run-history h2 { font-size: 18px; }
.plugin-run-history h3 { font-size: 16px; }
.plugin-run-history :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-run-history button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-run-history button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-run-history button:disabled { cursor: default; opacity: .5; }
.plugin-run-history :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-run-history :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-run-history :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-run-history small { font-size: 12px; }
.plugin-run-history p { max-width: 75ch; }
.plugin-run-history :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-run-history :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-run-history button { transition: none; }
 }
`;

export const styles = `
.plugin-source-settings{display:grid;gap:12px;color:var(--text);font:16px var(--sans,sans-serif);min-width:0}
.plugin-source-settings :is(h1,h2,h3,p){margin:0}
.plugin-source-settings p:empty{display:none}
.plugin-source-settings :is(h1,h2){font-size:20px}
.plugin-source-settings :is(.source-settings-tools,.admin-actions){display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-source-settings section,.plugin-source-settings fieldset{display:grid;gap:12px;border:1px solid var(--line);padding:12px;border-radius:6px;min-width:0}
.plugin-source-settings label{display:grid;gap:5px}
.plugin-source-settings .admin-toggle{display:flex;gap:8px;align-items:center}
.plugin-source-settings :is(button,input,select,textarea){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:8px;min-width:0;border-radius:6px;max-width:100%;box-sizing:border-box}
.plugin-source-settings :is(input:not([type=checkbox]):not([type=radio]),textarea,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-source-settings textarea{min-height:80px;resize:vertical}
.plugin-source-settings input[type=checkbox]{width:auto}
.plugin-source-settings button:disabled{opacity:.55}
.plugin-source-settings button{cursor:pointer}
.plugin-source-settings :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-source-settings [role=alert]{color:var(--bad)}
.plugin-source-settings small{color:var(--text-dim)}
.plugin-source-settings .admin-request{overflow-wrap:anywhere}
.plugin-source-settings .admin-columns{display:grid;grid-template-columns:minmax(260px,1fr) minmax(260px,1fr);gap:16px}
@media(max-width:760px){.plugin-source-settings .admin-columns{grid-template-columns:1fr}}
.plugin-source-settings { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-source-settings :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-source-settings h1 { font-size: 26px; }
.plugin-source-settings h2 { font-size: 20px; }
.plugin-source-settings h3 { font-size: 18px; }
.plugin-source-settings :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-source-settings button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-source-settings button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-source-settings button:disabled { cursor: default; opacity: .5; }
.plugin-source-settings :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-source-settings :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-source-settings :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-source-settings small { font-size: 14px; }
.plugin-source-settings p { max-width: 75ch; }
.plugin-source-settings :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-source-settings :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-source-settings button { transition: none; }
 }
.plugin-source-settings section { border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 16px 0; gap: 12px; }
.plugin-source-settings fieldset { border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 16px 0; }
`;

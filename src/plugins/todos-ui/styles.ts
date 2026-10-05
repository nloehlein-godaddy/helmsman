export const styles = `
.plugin-todos{color:var(--text);font:14px var(--sans,sans-serif);display:grid;gap:12px;min-width:0}
.plugin-todos [hidden]{display:none}
.plugin-todos h1,.plugin-todos h2{font-size:18px;margin:0}
.plugin-todos p:empty{display:none}
.plugin-todos p{margin:0}
.plugin-todos .todo-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.plugin-todos .todo-columns{display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1fr);gap:16px}
.plugin-todos .todo-list,.plugin-todos .todo-editor{display:grid;gap:12px;align-content:start;min-width:0}
.plugin-todos button,.plugin-todos input,.plugin-todos select,.plugin-todos textarea{font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:8px;min-width:0}
.plugin-todos :is(input:not([type=checkbox]):not([type=radio]),textarea,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-todos button{cursor:pointer}
.plugin-todos button:disabled{opacity:.55;cursor:default}
.plugin-todos label{display:grid;gap:5px}
.plugin-todos textarea{min-height:120px;resize:vertical}
.plugin-todos .todo-row{text-align:left;display:grid;gap:5px;width:100%;text-transform:none;letter-spacing:normal}
.plugin-todos .todo-row small{color:var(--muted)}
.plugin-todos [role=alert]{color:var(--bad)}
.plugin-todos .todo-request{border:1px solid var(--line);padding:10px;overflow-wrap:anywhere}
.plugin-todos :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:760px){.plugin-todos .todo-columns{grid-template-columns:1fr}}
.plugin-todos { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-todos :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-todos h1 { font-size: 24px; }
.plugin-todos h2 { font-size: 18px; }
.plugin-todos h3 { font-size: 16px; }
.plugin-todos :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-todos button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-todos button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-todos button:disabled { cursor: default; opacity: .5; }
.plugin-todos :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-todos :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-todos :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-todos small { font-size: 12px; }
.plugin-todos p { max-width: 75ch; }
.plugin-todos :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-todos :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-todos button { transition: none; }
 }
.plugin-todos .todo-row { padding: 12px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; font-weight: 600; }
.plugin-todos .todo-row small { font-weight: 400; color: var(--text-dim); }
.plugin-todos .todo-editor { gap: 12px; }
.plugin-todos .todo-request { border: 0; border-top: 1px solid var(--line); padding: 16px 0; }
`;

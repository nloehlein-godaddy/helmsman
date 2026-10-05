export const styles = `
.plugin-todos{color:var(--text);font:14px var(--sans,sans-serif);display:grid;gap:12px;min-width:0}
.plugin-todos [hidden]{display:none}.plugin-todos h1,.plugin-todos h2{font-size:18px;margin:0}
.plugin-todos p:empty{display:none}.plugin-todos p{margin:0}
.plugin-todos .todo-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.plugin-todos .todo-columns{display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1fr);gap:16px}
.plugin-todos .todo-list,.plugin-todos .todo-editor{display:grid;gap:10px;align-content:start;min-width:0}
.plugin-todos button,.plugin-todos input,.plugin-todos select,.plugin-todos textarea{font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:var(--radius,4px);padding:8px;min-width:0}
.plugin-todos :is(input:not([type=checkbox]):not([type=radio]),textarea,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}.plugin-todos button{cursor:pointer}.plugin-todos button:disabled{opacity:.55;cursor:default}
.plugin-todos label{display:grid;gap:5px}.plugin-todos textarea{min-height:120px;resize:vertical}
.plugin-todos .todo-row{text-align:left;display:grid;gap:5px;width:100%;text-transform:none;letter-spacing:normal}.plugin-todos .todo-row small{color:var(--muted)}
.plugin-todos [role=alert]{color:var(--bad)}.plugin-todos .todo-request{border:1px solid var(--line);padding:10px;overflow-wrap:anywhere}
.plugin-todos :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:760px){.plugin-todos .todo-columns{grid-template-columns:1fr}}
`;

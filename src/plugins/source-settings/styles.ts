export const styles = `.plugin-source-settings{display:grid;gap:12px;color:var(--text);font:14px var(--sans,sans-serif);min-width:0}
.plugin-source-settings :is(h1,h2,h3,p){margin:0}.plugin-source-settings p:empty{display:none}.plugin-source-settings :is(h1,h2){font-size:18px}
.plugin-source-settings :is(.source-settings-tools,.admin-actions){display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-source-settings section,.plugin-source-settings fieldset{display:grid;gap:12px;border:1px solid var(--line);padding:12px;border-radius:var(--radius,4px);min-width:0}
.plugin-source-settings label{display:grid;gap:5px}.plugin-source-settings .admin-toggle{display:flex;gap:8px;align-items:center}
.plugin-source-settings :is(button,input,select,textarea){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:8px;min-width:0;border-radius:var(--radius,4px);max-width:100%;box-sizing:border-box}
.plugin-source-settings :is(input:not([type=checkbox]):not([type=radio]),textarea,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}.plugin-source-settings textarea{min-height:80px;resize:vertical}.plugin-source-settings input[type=checkbox]{width:auto}.plugin-source-settings button:disabled{opacity:.55}.plugin-source-settings button{cursor:pointer}
.plugin-source-settings :focus-visible{outline:2px solid var(--accent);outline-offset:2px}.plugin-source-settings [role=alert]{color:var(--bad)}.plugin-source-settings small{color:var(--text-dim)}
.plugin-source-settings .admin-request{overflow-wrap:anywhere}.plugin-source-settings .admin-columns{display:grid;grid-template-columns:minmax(260px,1fr) minmax(260px,1fr);gap:16px}
@media(max-width:760px){.plugin-source-settings .admin-columns{grid-template-columns:1fr}}`;

export const styles = `
.plugin-triage{display:grid;gap:12px;color:var(--text);font:14px var(--sans,sans-serif);min-width:0}
.plugin-triage :is(h1,h2,h3,p){margin:0}
.plugin-triage h1{font-size:22px}
.plugin-triage :is(h2,h3){font-size:14px}
.plugin-triage :is(.triage-tools,.triage-toolbar,fieldset){display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-triage :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:6px 9px;border-radius:6px;max-width:100%}
.plugin-triage select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-triage button{cursor:pointer}
.plugin-triage button:disabled{opacity:.5}
.plugin-triage :is(button,select,input,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-triage section{display:grid;gap:12px;min-width:0;padding:12px;border:1px solid var(--line);border-radius:6px}
.plugin-triage ul{list-style:none;padding:0;margin:0}
.plugin-triage li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:9px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-triage a{color:var(--accent)}
.plugin-triage small{color:var(--text-dim)}
.plugin-triage [role=alert]{color:var(--bad)}
.plugin-triage dl{display:flex;gap:18px;flex-wrap:wrap}
.plugin-triage dt{color:var(--text-dim)}
.plugin-triage dd{margin:4px 0;font-weight:600}
.plugin-triage table{border-collapse:collapse;text-align:left;overflow-wrap:anywhere;width:100%}
.plugin-triage :is(th,td){border-bottom:1px solid var(--line);padding:8px;vertical-align:top}
.plugin-triage .table-scroll{overflow:auto}
.plugin-triage .triage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
.plugin-triage .triage-description{display:grid;gap:6px;flex-basis:100%}
.plugin-triage .triage-description-content{display:grid;gap:6px;min-width:0}
.plugin-triage .triage-description-text{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:900px){.plugin-triage .triage-grid{grid-template-columns:1fr}}
.plugin-triage { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-triage :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-triage h1 { font-size: 24px; }
.plugin-triage h2 { font-size: 18px; }
.plugin-triage h3 { font-size: 16px; }
.plugin-triage :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-triage button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-triage button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-triage button:disabled { cursor: default; opacity: .5; }
.plugin-triage :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-triage :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-triage :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-triage small { font-size: 12px; }
.plugin-triage p { max-width: 75ch; }
.plugin-triage :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-triage :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-triage button { transition: none; }
 }
.plugin-triage section { border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 16px 0; gap: 12px; }
`;

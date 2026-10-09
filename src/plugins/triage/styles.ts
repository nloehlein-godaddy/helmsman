const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-triage{display:grid;gap:12px;color:var(--text);font:16px var(--sans,sans-serif);min-width:0}
.plugin-triage :is(h1,h2,h3,p){margin:0}
.plugin-triage h1{font-size:24px}
.plugin-triage :is(h2,h3){font-size:16px}
.plugin-triage :is(.triage-tools,.triage-toolbar,fieldset){display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-triage :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:6px 9px;border-radius:6px;max-width:100%}
.plugin-triage select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-triage button{cursor:pointer}
.plugin-triage button:disabled{opacity:.5}
.plugin-triage :is(button,select,input,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-triage section{display:grid;gap:12px;min-width:0;padding:12px;border:1px solid var(--line);border-radius:6px}
.plugin-triage ul{list-style:none;padding:0;margin:0}
.plugin-triage li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:9px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-triage a{color:var(--accent-text,var(--accent))}
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
.plugin-triage { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-triage :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-triage h1 { font-size: 26px; }
.plugin-triage h2 { font-size: 20px; }
.plugin-triage h3 { font-size: 18px; }
.plugin-triage :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-triage button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-triage button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-triage button:disabled { cursor: default; opacity: .5; }
.plugin-triage :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-triage :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-triage :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-triage small { font-size: 14px; }
.plugin-triage p { max-width: 75ch; }
.plugin-triage :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-triage :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-triage button { transition: none; }
 }
.plugin-triage section { border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 16px 0; gap: 12px; }

.plugin-triage.triage-panel{gap:16px;font-size:14px}
.triage-panel .triage-toolbar{justify-content:space-between}
.triage-panel .triage-filters{margin:0;min-width:0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2,var(--face-hi));gap:16px;align-items:flex-end}
.triage-panel .triage-filters legend{padding:0 6px;color:var(--text-dim);font-size:12px;font-weight:600}
.triage-panel .triage-filters>label{display:grid;gap:4px;font-size:12px;font-weight:600;color:var(--text-dim)}
.triage-panel .triage-source-filter{flex:1 1 180px;max-width:340px}
.triage-panel :is(button,select){font-size:14px;min-height:32px;color:var(--text);background:var(--panel-hi,var(--face-hi));border-radius:6px}
.triage-panel select{color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi))}
.triage-panel .triage-priorities{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.triage-panel .triage-priorities>span{width:100%;font-size:12px;font-weight:600;color:var(--text-dim)}
.triage-panel .triage-priorities label{display:flex;gap:4px;align-items:center;min-height:32px;padding:0 5px;border:1px solid var(--line);border-radius:6px;color:var(--text);background:var(--panel,var(--face));cursor:pointer}
.triage-panel input[type=checkbox]{margin:0;accent-color:var(--input-accent,var(--accent-text,var(--accent)));width:14px;height:14px}
.plugin-triage.triage-panel section{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel,var(--face));gap:12px}
.triage-panel .triage-column-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:-16px -16px 0;padding:14px 16px;background:var(--panel-hi,var(--face-hi));border-bottom:1px solid var(--line);border-radius:11px 11px 0 0}
.triage-panel .triage-column-identity{display:grid;gap:4px;min-width:0}
.triage-panel .triage-column-identity h3{font-size:16px;font-weight:650}
.triage-panel .triage-column-source{font-size:12px;overflow-wrap:anywhere}
.triage-panel .triage-collapse{flex:none;font-size:12px;min-height:28px;padding:3px 6px;background:transparent;color:var(--text-dim);border-color:transparent}
.triage-panel .triage-task{display:grid;gap:8px;align-items:start;padding:16px 0;overflow-wrap:anywhere}
.triage-panel .triage-task:first-child{padding-top:4px}
.triage-panel .triage-task:last-child{border-bottom:0;padding-bottom:4px}
.triage-panel .triage-task-title{color:var(--text);font-size:16px;font-weight:600;line-height:1.4;text-decoration:none}
.triage-panel a.triage-task-title:hover{text-decoration:underline;text-underline-offset:3px}
.triage-panel :is(.triage-task-identity,.triage-task-metadata,.triage-task-actions){display:flex;gap:8px 12px;flex-wrap:wrap;align-items:center;min-width:0}
.triage-panel .triage-task-identity small{font-size:12px}
.triage-panel .triage-task-identity small:first-child{font-weight:600}
.triage-panel .triage-task-metadata{gap:8px 14px;font-size:12px;color:var(--text-dim)}
.triage-panel :is(.triage-task-state,.triage-task-priority){display:inline-flex;gap:5px;align-items:center}
.triage-panel .triage-task-state[data-state=ready] .triage-phosphor{color:var(--good)}
.triage-panel .triage-task-state[data-state=in_progress] .triage-phosphor{color:var(--accent-text,var(--accent))}
.triage-panel .triage-task-state[data-state=review] .triage-phosphor{color:var(--review)}
.triage-panel .triage-task-state:is([data-state=blocked],[data-state=unknown]) .triage-phosphor{color:var(--bad)}
.triage-panel .triage-task-priority:is([data-priority="0"],[data-priority="1"]) .triage-phosphor{color:var(--queued)}
.triage-panel .triage-description{display:grid;gap:8px}
.triage-panel .triage-description>button{justify-self:start;background:transparent;color:var(--text-dim);border-color:transparent;min-height:28px;padding:2px 0;font-size:12px}
.triage-panel .triage-description>button:hover:not(:disabled){background:transparent;color:var(--text);border-color:transparent;text-decoration:underline;text-underline-offset:3px}
.triage-panel .triage-description-content{font-size:14px;padding:12px;border-left:1px solid var(--line-strong);background:var(--panel-2,var(--face-hi));border-radius:0 6px 6px 0}
.triage-panel .triage-task-actions{gap:8px;font-size:12px}
.triage-panel .triage-task-actions button{font-size:12px;padding:4px 8px}
.triage-panel .triage-task-actions a{display:inline-flex;gap:5px;align-items:center;font-size:12px;text-underline-offset:3px;color:var(--accent-text,var(--accent))}
.triage-panel .triage-launch{color:var(--accent-text,var(--accent));font-weight:600}
.triage-panel .triage-launch-note{font-size:12px}
.triage-panel .triage-pagination{display:flex;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding-top:12px;color:var(--text-dim);font-size:12px}
.triage-panel .triage-pagination button{font-size:12px;padding:4px 8px}
.triage-panel .triage-phosphor{display:inline-block;width:16px;height:16px;flex-shrink:0;font-family:"Helmsman Phosphor Regular";font-size:16px;font-weight:400;font-style:normal;font-synthesis:none;line-height:1;letter-spacing:normal;text-transform:none;vertical-align:-3px}
.triage-panel .triage-phosphor::before{content:attr(data-glyph)}
.triage-panel button>.triage-phosphor{margin-right:5px}
.triage-panel :is(button,input,select,textarea,summary,a):focus-visible{outline-color:var(--accent-text,var(--accent))}
.triage-panel [data-triage-group]:focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:3px}
@media(max-width:1100px){.plugin-triage.triage-panel .triage-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.triage-panel .triage-column-heading{flex-wrap:wrap}}
@media(max-width:760px){.plugin-triage.triage-panel .triage-grid{grid-template-columns:1fr}.triage-panel .triage-filters{padding:12px;gap:12px}.triage-panel .triage-filters>label{flex:1 1 140px;max-width:none}.triage-panel .triage-column-heading{flex-wrap:nowrap}}
@media(pointer:coarse){.triage-panel :is(button,select,.triage-priorities label,.triage-task-actions a){min-height:44px}.triage-panel .triage-description>button{padding:6px 0}.triage-panel .triage-priorities label{padding:0 8px}}
`;

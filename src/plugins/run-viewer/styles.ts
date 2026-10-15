const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-run-viewer{color:var(--text);font:16px/1.5 var(--sans,sans-serif);min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;overflow-wrap:anywhere}
.plugin-run-viewer [hidden]{display:none!important}
.plugin-run-viewer :is(h1,h2,h3,p){margin:0}
.plugin-run-viewer :is(h1,h2,h3){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance}
.plugin-run-viewer h1{font-size:26px}.plugin-run-viewer h2{font-size:20px}.plugin-run-viewer h3{font-size:17px;font-weight:650}
.plugin-run-viewer section{min-width:0;display:grid;gap:12px}
.plugin-run-viewer :is(button,input,select,textarea){box-sizing:border-box;border-radius:6px;font:16px/1.4 var(--sans,sans-serif);min-height:36px;color:var(--text)}
.plugin-run-viewer :is(button,select){background:var(--face-hi);border:1px solid var(--line-strong);padding:6px 12px}
.plugin-run-viewer :is(input,select,textarea){padding:8px 12px;background:var(--control-bg,var(--face-hi));border:1px solid var(--control-border,var(--line-strong));max-width:100%}
.plugin-run-viewer button{display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;letter-spacing:normal;text-transform:none;transition:background-color 160ms ease-out,border-color 160ms ease-out}
.plugin-run-viewer button:hover:not(:disabled){background:var(--panel-hi);border-color:var(--line-strong)}
.plugin-run-viewer button:disabled{opacity:.5;cursor:default}
.plugin-run-viewer :is(button,input,select,textarea,summary,a,[role=separator]):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-run-viewer :is(p,small){line-height:1.5;overflow-wrap:anywhere}.plugin-run-viewer p{max-width:75ch}.plugin-run-viewer small{font-size:14px;color:var(--text-dim)}
.plugin-run-viewer [role=alert]{color:var(--bad)}
.plugin-run-viewer .run-icon{display:inline-block;flex:none;width:18px;height:18px;font:18px/1 "Helmsman Phosphor Regular";font-synthesis:none;letter-spacing:normal;text-transform:none;vertical-align:-3px}
.plugin-run-viewer .run-icon::before{content:attr(data-glyph)}
.plugin-run-viewer h3>.run-icon,.plugin-run-viewer strong>.run-icon{margin-right:8px;color:var(--accent-text,var(--accent))}
.plugin-run-viewer .run-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.plugin-run-viewer .run-tabs{display:flex;align-items:stretch;gap:8px;overflow-x:auto;padding:0 0 12px;scrollbar-width:thin;border-bottom:1px solid var(--line)}
.plugin-run-viewer .run-tabs:empty{display:none}
.plugin-run-viewer .run-tab{display:flex;flex:0 0 290px;box-sizing:border-box;min-width:0;max-width:100%;align-items:center;gap:4px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.plugin-run-viewer [role=tab]{display:block;flex:1;min-width:0;padding:0;border:0;background:transparent;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plugin-run-viewer [aria-selected=true]{color:var(--accent-text,var(--accent))}
.plugin-run-viewer .run-tab:has([aria-selected=true]){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--panel))}
.plugin-run-viewer .run-tab-identity{display:block;overflow:hidden;text-overflow:ellipsis;font:14px/1.5 var(--mono,monospace)}
.plugin-run-viewer .run-tab-status{display:block;font-size:14px;color:var(--text-dim)}
.plugin-run-viewer [data-run-status=succeeded] .run-tab-status{color:var(--good)}
.plugin-run-viewer [data-run-status=running] .run-tab-status,.plugin-run-viewer .run-tab-status[data-review-outcome=COMMENT]{color:var(--review)}
.plugin-run-viewer [data-run-status=failed] .run-tab-status,.plugin-run-viewer .run-tab-status[data-review-outcome=REQUEST_CHANGES],.plugin-run-viewer .run-tab-status[data-feedback-outcome=changes_remaining]{color:var(--bad)}
.plugin-run-viewer .run-tab-status[data-feedback-outcome=awaiting_decision]{color:var(--review)}
.plugin-run-viewer .run-tab-open,.plugin-run-viewer .run-tab>button:not([role=tab]){display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:32px;height:32px;min-height:32px;padding:4px;color:var(--text-dim);text-decoration:none;border:1px solid transparent;background:transparent}
.plugin-run-viewer .run-tab-open:hover,.plugin-run-viewer .run-tab>button:not([role=tab]):hover{color:var(--text);border-color:var(--line)}
.plugin-run-viewer .run-overview{display:grid;gap:10px;padding-block:4px 8px}
.plugin-run-viewer .run-overview-identity{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px}
.plugin-run-viewer .run-overview-identity>strong{font-weight:500}
.plugin-run-viewer .run-overview-identity>.run-icon{color:var(--text-dim)}
.plugin-run-viewer .run-identity-details{margin-left:auto;color:var(--text-dim);font-size:14px;min-width:0}
.plugin-run-viewer .run-identity-details code{display:block;overflow-wrap:anywhere;font:13px/1.5 var(--mono,monospace);margin-top:6px}
.plugin-run-viewer :is(.run-identity-details,.run-preview-details,.run-request-details)>summary{cursor:pointer}
.plugin-run-viewer .run-identity-details>summary>.run-icon{margin-right:5px}
.plugin-run-viewer .run-status-line{display:flex;gap:8px;flex-wrap:wrap}
.plugin-run-viewer .run-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:4px;background:var(--panel-hi);font-size:14px;color:var(--text-dim)}
.plugin-run-viewer .run-badge[data-tone=good]{color:var(--good)}.plugin-run-viewer .run-badge[data-tone=bad]{color:var(--bad)}.plugin-run-viewer .run-badge[data-tone=review]{color:var(--review)}
.plugin-run-viewer .run-log-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--line)}
.plugin-run-viewer .run-log-heading h3{display:flex;align-items:center;white-space:nowrap}
.plugin-run-viewer .run-preview-details{font-size:14px;color:var(--text-dim);text-align:right;max-width:55ch}
.plugin-run-viewer .run-preview-details[open] small{display:block;margin-top:6px;text-align:left}
.plugin-run-viewer .run-log-toolbar{padding:10px;background:var(--panel);border:1px solid var(--line);border-radius:6px;gap:6px}
.plugin-run-viewer .run-log-toolbar button{font-size:14px;min-height:36px;padding:6px 10px}
.plugin-run-viewer .run-log-toolbar .whiteboard-companion{margin-left:auto;gap:6px;font-size:14px}
.plugin-run-viewer .run-stop:not(:disabled){color:var(--bad)}
.plugin-run-viewer .run-icon-action{width:36px;padding:6px}
.plugin-run-viewer .run-icon-action>span:not(.run-icon){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.plugin-run-viewer .run-log{box-sizing:border-box;max-height:min(1200px,80dvh);min-height:min(180px,60dvh);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:14px;background:var(--face);color:var(--text);border:1px solid var(--line);border-radius:6px;font:14px/1.6 var(--mono,monospace);scrollbar-width:thin;scrollbar-color:var(--line-strong) var(--face)}
.plugin-run-viewer .run-log::selection{background:var(--accent);color:var(--on-accent)}
.plugin-run-viewer .run-log-resize{display:flex;align-items:center;justify-content:center;gap:8px;min-height:28px;margin-top:-12px;cursor:ns-resize;touch-action:none;user-select:none;color:var(--text-dim);font-size:12px;border-radius:0 0 6px 6px}
.plugin-run-viewer .run-log-resize:is(:hover,[data-dragging=true]){background:var(--panel-hi);color:var(--text)}
.plugin-run-viewer .run-log-resize .run-icon{width:20px;height:20px;font-size:20px;transform:rotate(90deg)}
.plugin-run-viewer .run-saved-requests,.plugin-run-viewer .run-saved-results{padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.plugin-run-viewer .run-saved-requests>h3{display:flex;align-items:center;gap:8px}
.plugin-run-viewer .run-saved-requests>h3>.run-icon{margin:0;color:var(--accent-text,var(--accent))}
.plugin-run-viewer .run-saved-requests>h3>span:not(.run-icon){font-size:13px;color:var(--text-dim);font-weight:500;margin-left:auto}
.plugin-run-viewer .run-row{padding:12px 0;border-top:1px solid var(--line-faint);display:grid;gap:8px;overflow-wrap:anywhere;min-width:0}
.plugin-run-viewer .run-request-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.plugin-run-viewer .run-request-header>strong{font-size:16px;font-weight:600}
.plugin-run-viewer .run-row p{font-size:14px;color:var(--text-dim)}
.plugin-run-viewer .run-request-details{font-size:14px;color:var(--text-dim)}
.plugin-run-viewer .run-request-details small{display:block;font:13px/1.6 var(--mono,monospace);margin-top:6px}
.plugin-run-viewer .run-row .run-tools button{font-size:14px}
.plugin-run-viewer .run-saved-results>summary{cursor:pointer;font-weight:600;font-size:16px}.plugin-run-viewer .run-saved-results>summary>.run-icon{margin-right:8px;color:var(--accent-text,var(--accent))}
.plugin-run-viewer .run-saved-results[open]>.run-row:first-of-type{margin-top:12px}
.plugin-run-viewer .run-picker{padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.plugin-run-viewer .run-picker-list{display:grid;margin:0;padding:0;list-style:none}
.plugin-run-viewer .run-picker-list>li+li{border-top:1px solid var(--line-faint)}
.plugin-run-viewer .run-picker-row{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;padding:12px 8px;text-align:left;background:transparent;border:0}
.plugin-run-viewer .run-picker-row:hover:not(:disabled){background:var(--panel-hi)}
.plugin-run-viewer .run-picker-title{font-weight:600}.plugin-run-viewer .run-picker-meta{font-size:14px;color:var(--text-dim)}.plugin-run-viewer .run-picker-state{color:var(--text-dim)}
@media(max-width:600px){.plugin-run-viewer .run-overview-identity>strong{flex:1;min-width:0;overflow-wrap:anywhere}.plugin-run-viewer .run-identity-details{flex-basis:100%;margin:0}.plugin-run-viewer .run-log-toolbar .whiteboard-companion{margin-left:0}.plugin-run-viewer :is(.run-saved-requests,.run-saved-results){padding:12px}.plugin-run-viewer .run-log-heading{gap:8px}.plugin-run-viewer .run-preview-details{max-width:50%}}
@media(any-pointer:coarse){.plugin-run-viewer :is(button,select,summary,.run-log-resize){min-height:44px;min-width:44px}.plugin-run-viewer .run-tab-open,.plugin-run-viewer .run-tab>button:not([role=tab]){width:44px;height:44px;min-height:44px}.plugin-run-viewer .run-log-toolbar button{min-height:44px}.plugin-run-viewer summary{align-content:center}}
@media(prefers-reduced-motion:reduce){.plugin-run-viewer button{transition:none}}
`;

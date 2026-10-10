const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-bugs{display:grid;gap:16px;color:var(--text);font:14px/1.5 var(--sans,sans-serif);min-width:0}
.plugin-bugs :is(h1,h2,h3,p,dl){margin:0}
.plugin-bugs :is(h1,h2,h3){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance}
.plugin-bugs h1{font-size:26px}
.plugin-bugs h2{font-size:20px}
.plugin-bugs h3{font-size:18px}
.plugin-bugs .bugs-icon{font-family:"Helmsman Phosphor Regular";font-size:16px;font-weight:400;line-height:1;display:inline-block;flex:none}
.plugin-bugs :is(button,select){box-sizing:border-box;font:14px/1.4 var(--sans,sans-serif);min-height:32px;color:var(--text);background:var(--panel-hi,var(--face-hi));border:1px solid var(--line-strong);padding:6px 10px;border-radius:6px;max-width:100%}
.plugin-bugs select{color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong));width:100%;min-width:0}
.plugin-bugs button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background-color 160ms ease-out,border-color 160ms ease-out}
.plugin-bugs button:hover:not(:disabled){background:var(--face-hi);border-color:var(--accent)}
.plugin-bugs button:disabled{cursor:default;opacity:.5}
.plugin-bugs :is(button,select,a):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.plugin-bugs .bugs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.plugin-bugs .bugs-filters{display:flex;gap:12px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2,var(--face-hi));min-width:0}
.plugin-bugs .bugs-source{display:grid;gap:4px;flex:1 1 240px;max-width:420px;min-width:0;font-size:12px;font-weight:600;color:var(--text-dim)}
.plugin-bugs .bugs-report{display:grid;gap:0;min-width:0;background:var(--panel,var(--face));border:1px solid var(--line);border-radius:12px;overflow:hidden}
.plugin-bugs .bugs-report-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;background:var(--panel-hi,var(--face-hi));border-bottom:1px solid var(--line)}
.plugin-bugs .bugs-report-identity{display:grid;gap:3px;min-width:0;overflow-wrap:anywhere}
.plugin-bugs .bugs-observed{font-size:12px;text-align:right;max-width:34ch}
.plugin-bugs small{font-size:12px;color:var(--text-dim);line-height:1.5;overflow-wrap:anywhere}
.plugin-bugs p{max-width:75ch;overflow-wrap:anywhere}
.plugin-bugs .bugs-notice{padding:12px 16px;color:var(--text);background:var(--panel-2,var(--face-hi));border-radius:6px}
.plugin-bugs .bugs-report>p{margin:12px 16px}
.plugin-bugs a{color:var(--accent-text,var(--accent));text-decoration-thickness:1px;text-underline-offset:3px}
.plugin-bugs a:hover{text-decoration:underline}
.plugin-bugs .bugs-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:16px;gap:16px;border-bottom:1px solid var(--line)}
.plugin-bugs dt{color:var(--text-dim);font-size:12px;display:flex;align-items:center;gap:6px}
.plugin-bugs dd{margin:4px 0 0;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.plugin-bugs .bugs-metrics dd{font-size:18px;line-height:1.35}
.plugin-bugs .bugs-evidence{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:16px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel-2,var(--face-hi))}
.plugin-bugs .bugs-evidence>div>small{display:block;margin-top:4px}
.plugin-bugs .bugs-coverage{color:var(--text-dim);font-size:12px}
.plugin-bugs table{border-collapse:collapse;text-align:left;overflow-wrap:anywhere;width:100%;table-layout:fixed}
.plugin-bugs :is(th,td){border-bottom:1px solid var(--line);padding:12px 16px;vertical-align:top}
.plugin-bugs th{font-size:12px;font-weight:600;color:var(--text-dim)}
.plugin-bugs th:first-child{width:53%}
.plugin-bugs tbody tr:last-child td{border-bottom:0}
.plugin-bugs .bugs-title{display:block;font-weight:600;font-size:15px;line-height:1.4;color:var(--text);text-decoration:none}
.plugin-bugs .bugs-title-cell>small{display:block;margin-top:4px}
.plugin-bugs .bugs-description{display:grid;gap:8px;margin-top:8px}
.plugin-bugs .bugs-description button{justify-self:start;font-size:12px;min-height:28px;padding:3px 7px;background:transparent;color:var(--text-dim);border-color:var(--line)}
.plugin-bugs .bugs-description-content{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;border-left:1px solid var(--line-strong);background:var(--panel-2,var(--face-hi));border-radius:0 6px 6px 0}
.plugin-bugs .severity-badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:1px 6px;font-weight:700;line-height:1.35}
.plugin-bugs :is(.severity-s0,.severity-s1){color:var(--bad-text,var(--bad))}
.plugin-bugs :is(.severity-s2,.severity-s3){color:var(--accent-text,var(--accent))}
.plugin-bugs :is(.severity-s4,.severity-s5){color:var(--text-dim)}
@media(max-width:700px){
.plugin-bugs .bugs-report-heading{flex-direction:column;gap:6px}
.plugin-bugs .bugs-observed{text-align:left;max-width:none}
.plugin-bugs .bugs-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.plugin-bugs .bugs-evidence{grid-template-columns:1fr;gap:12px}
.plugin-bugs :is(table,tbody){display:block}
.plugin-bugs thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.plugin-bugs tbody tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--line);padding:12px 16px;gap:10px 12px}
.plugin-bugs tbody tr:last-child{border-bottom:0}
.plugin-bugs td{display:block;padding:0;border:0}
.plugin-bugs td[data-label]::before{content:attr(data-label);display:block;color:var(--text-dim);font-size:12px;margin-bottom:4px}
.plugin-bugs :is(.bugs-title-cell,.bugs-empty){grid-column:1/-1}
}
@media(pointer:coarse){.plugin-bugs :is(button,select),.plugin-bugs .bugs-description button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.plugin-bugs button{transition:none}}
`;

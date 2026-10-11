const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.campaign-page{font:14px/1.5 var(--sans,sans-serif);color:var(--text);min-width:0;display:grid;gap:16px;padding:0}
.campaign-page :is(h2,h3,h4,p,ul){margin:0}
.campaign-page :is(h2,h3,h4){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;display:flex;align-items:center;gap:8px;overflow-wrap:anywhere;text-wrap:balance}
.campaign-page h2{font-size:20px}
.campaign-page h3{font-size:17px}
.campaign-page h4{font-size:14px}
.campaign-page :is(p,small){overflow-wrap:anywhere}
.campaign-page p{max-width:75ch}
.campaign-page .campaign-intro{color:var(--text-dim);font-size:14px;max-width:80ch}
.campaign-page [hidden]{display:none!important}
.campaign-page [data-storage-error]:empty{display:none}
.campaign-layout{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:24px;align-items:start}
.campaign-layout>*,.campaign-page :is(form,label,fieldset),.campaign-settings>div{min-width:0}
.campaign-sidebar{display:grid;gap:16px}
.campaign-page .campaign-panel{padding:16px;border:1px solid var(--line);border-radius:12px;display:grid;gap:12px;background:var(--panel)}
.campaign-page .campaign-create{background:var(--panel-2,var(--panel));gap:14px}
.campaign-section-heading,.campaign-phase-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.campaign-page fieldset{margin:0;border:0;padding:0;display:grid;gap:12px}
.campaign-page label{display:grid;gap:5px;font-size:12px;font-weight:600;color:var(--text-dim)}
.campaign-page :is(input,select,textarea){width:100%;min-width:0;max-width:100%;box-sizing:border-box;font:14px/1.4 var(--sans,sans-serif);color:var(--input-text,var(--text));background:var(--control-bg,var(--bg));border:1px solid var(--control-border,var(--line-strong));border-radius:6px;padding:7px 10px;min-height:34px}
.campaign-page input::placeholder,.campaign-page textarea::placeholder{color:var(--input-placeholder,var(--text-dim))}
.campaign-page button{font:14px/1.4 var(--sans,sans-serif);color:var(--text);background:var(--panel-hi,var(--panel));border:1px solid var(--line-strong,var(--line));border-radius:6px;padding:6px 10px;min-height:32px;max-width:100%;white-space:normal;overflow-wrap:anywhere;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background-color 160ms ease-out,border-color 160ms ease-out}
.campaign-page button:hover:not(:disabled){background:var(--face-hi);border-color:var(--accent-text,var(--accent))}
.campaign-page button:disabled{opacity:.5;cursor:default}
.campaign-page :is(button,input,select,textarea,summary,a,.campaign-table-wrap):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.campaign-page :is(button[type=submit],.campaign-primary){background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.campaign-page :is(button[type=submit],.campaign-primary):hover:not(:disabled){background:var(--accent-bright,var(--accent));border-color:var(--accent-bright,var(--accent));color:var(--on-accent)}
.campaign-page .campaign-destructive{color:var(--bad-text,var(--bad))}
.campaign-icon{font-family:"Helmsman Phosphor Regular";font-size:18px;font-weight:400;line-height:1;display:inline-block;flex:none}
.campaign-page .campaign-icon-button{width:32px;min-width:32px;padding:6px}
.campaign-drafts{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--text-dim)}
.campaign-scope{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-dim)}
.campaign-scope:empty{display:none}
.campaign-page .campaign-scope button{font-size:12px;background:transparent}
.campaign-list{list-style:none;padding:0;display:grid;gap:0}
.campaign-list li+li{border-top:1px solid var(--line-faint,var(--line))}
.campaign-list li{padding:8px 0;min-width:0}
.campaign-list small,.campaign-page td small{display:block;margin-top:4px;overflow-wrap:anywhere;font-size:12px;color:var(--text-dim)}
.campaign-page .campaign-list button{width:100%;justify-content:flex-start;text-align:left;border:0;padding:6px;background:transparent;font-weight:600}
.campaign-page .campaign-list button[aria-pressed=true]{color:var(--accent-text,var(--accent));background:var(--panel-hi,var(--face-hi))}
.campaign-detail{display:grid;gap:16px;min-width:0;align-content:start}
.campaign-detail-heading{display:grid;gap:5px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.campaign-add-phase{padding:12px 16px;background:var(--panel-2,var(--panel));border:1px solid var(--line);border-radius:12px}
.campaign-add-phase fieldset{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px}
.campaign-add-phase label{flex:1 1 220px}
.campaign-page .campaign-phase{gap:12px}
.campaign-phase-heading{padding:14px 16px;margin:-16px -16px 0;background:var(--panel-hi,var(--face-hi));border-bottom:1px solid var(--line);border-radius:11px 11px 0 0}
.campaign-state{font-size:12px;font-weight:400;color:var(--text-dim)}
.campaign-task-state{display:inline-flex;align-items:center;gap:5px}
.campaign-task-state[data-state=queued]{color:var(--queued-text,var(--queued))}
.campaign-task-state[data-state=failed]{color:var(--bad-text,var(--bad))}
.campaign-task-state[data-state=succeeded]{color:var(--good-text,var(--good))}
.campaign-task-state[data-state=running],.campaign-state[data-state=running]{color:var(--review-text,var(--review))}
.campaign-state[data-state=completed]{color:var(--good-text,var(--good))}
.campaign-actions{display:flex;flex-wrap:wrap;gap:8px}
.campaign-hint{font-size:12px;color:var(--text-dim);line-height:1.5}
.campaign-error{color:var(--bad-text,var(--bad));overflow-wrap:anywhere;font-size:14px}
.campaign-import{padding-top:14px;border-top:1px solid var(--line);display:grid;gap:12px}
.campaign-import fieldset{grid-template-columns:minmax(120px,1fr) minmax(0,2fr)}
.campaign-import :is(label:has(textarea),details,button[type=submit]){grid-column:1/-1}
.campaign-import button[type=submit]{justify-self:start}
.campaign-settings{font-size:12px;color:var(--text-dim)}
.campaign-settings summary{cursor:pointer;width:fit-content;min-height:28px;align-content:center;border-radius:3px}
.campaign-settings>div{display:grid;gap:12px;padding-top:12px}
.campaign-settings>p{margin-top:8px}
.campaign-preview,.campaign-confirm{border:1px solid var(--line-strong);border-radius:12px;padding:16px;background:var(--panel-2,var(--panel));display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.campaign-preview :is(h4,p,ol),.campaign-confirm p{flex-basis:100%}
.campaign-preview ol{margin:0;max-height:24rem;overflow:auto;padding-left:22px}
.campaign-preview li{white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px}
.campaign-preview li:last-child{margin-bottom:0}
.campaign-tasks-heading{padding-top:12px;border-top:1px solid var(--line)}
.campaign-table-wrap{overflow:auto;min-width:0}
.campaign-page table{border-collapse:collapse;width:100%;text-align:left;font-size:12px;font-variant-numeric:tabular-nums}
.campaign-page :is(th,td){padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.campaign-page th{font-size:12px;color:var(--text-dim);font-weight:600}
.campaign-page td:first-child{min-width:140px;max-width:30rem;overflow-wrap:anywhere}
.campaign-page td button{font-size:12px;margin:0 6px 6px 0}
.campaign-empty{display:grid;gap:10px;padding:20px 24px;background:var(--panel-2,var(--panel));border-radius:12px;border:1px solid var(--line)}
.campaign-recovery{font:14px/1.5 var(--sans,sans-serif);color:var(--text);margin-top:20px;min-width:0}
.campaign-recovery article{border-top:1px solid var(--line-faint,var(--line));padding:12px 0;overflow-wrap:anywhere}
.campaign-recovery summary{cursor:pointer;color:var(--text-dim);font-size:12px;padding:6px 0;min-height:28px;align-content:center}
.campaign-recovery :is(button,summary):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
@media(max-width:1000px){.campaign-layout{grid-template-columns:minmax(220px,260px) minmax(0,1fr);gap:16px}.campaign-import fieldset{grid-template-columns:1fr}}
@media(max-width:850px){.campaign-layout{grid-template-columns:minmax(0,1fr)}.campaign-sidebar{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.campaign-sidebar{grid-template-columns:1fr}.campaign-empty{padding:16px}.campaign-section-heading{align-items:flex-start}}
@media(max-width:600px){
.campaign-table-wrap{overflow:visible}
.campaign-page :is(table,tbody){display:block}
.campaign-page thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.campaign-page tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;border-bottom:1px solid var(--line);padding:14px 0}
.campaign-page tbody tr:last-child{border-bottom:0}
.campaign-page td{display:block;min-width:0;padding:0;border:0}
.campaign-page td:first-child{min-width:0;max-width:none;font-size:14px;font-weight:600}
.campaign-page :is(.campaign-task-title,.campaign-task-repo,.campaign-task-actions,.campaign-task-empty){grid-column:1/-1}
.campaign-page td[data-label]::before{content:attr(data-label);display:block;color:var(--text-dim);font-size:12px;font-weight:400;margin-bottom:4px}
.campaign-page .campaign-task-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.campaign-page .campaign-task-actions:empty{display:none}
.campaign-page .campaign-task-actions::before{flex-basis:100%;margin-bottom:0}
.campaign-page .campaign-task-actions button{margin:0}
}
@media(pointer:coarse){.campaign-page :is(button,input,select,summary),.campaign-recovery :is(button,summary){min-height:44px}}
@media(prefers-reduced-motion:reduce){.campaign-page button{transition:none}}
`;

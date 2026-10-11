const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-run-history{color:var(--text);font:14px/1.5 var(--sans,sans-serif);min-width:0;display:grid;gap:16px}
.plugin-run-history :is(h1,h2,h3,p){margin:0}
.plugin-run-history :is(h1,h2,h3){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance}
.plugin-run-history h1{font-size:26px}
.plugin-run-history h2{font-size:20px;display:flex;align-items:center;gap:8px}
.plugin-run-history h3{font-size:18px}
.plugin-run-history :is(button,select){box-sizing:border-box;font:14px/1.4 var(--sans,sans-serif);min-height:32px;color:var(--text);background:var(--panel-hi,var(--face-hi));border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;max-width:100%}
.plugin-run-history select{color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong));width:100%}
.plugin-run-history button{cursor:pointer;transition:background-color 160ms ease-out,border-color 160ms ease-out;display:inline-flex;align-items:center;gap:6px}
.plugin-run-history button:disabled{opacity:.5;cursor:default}
.plugin-run-history button:hover:not(:disabled){background:var(--face-hi);border-color:var(--accent)}
.plugin-run-history :is(button,select,a,summary):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.plugin-run-history .run-tools{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.plugin-run-history .run-filters{display:flex;gap:12px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2,var(--face-hi));min-width:0}
.plugin-run-history .run-filters>label{display:grid;gap:4px;font-size:12px;font-weight:600;color:var(--text-dim);flex:1 1 220px;max-width:300px;min-width:0}
.plugin-run-history [role=alert]{color:var(--bad-text,var(--bad));padding:10px 12px;background:var(--panel-2,var(--face-hi));border-radius:6px;overflow-wrap:anywhere}
.plugin-run-history a{color:var(--accent-text,var(--accent));text-underline-offset:3px;text-decoration-thickness:1px}
.plugin-run-history :is(p,small){line-height:1.5;overflow-wrap:anywhere}
.plugin-run-history small{color:var(--text-dim);font-size:12px}
.plugin-run-history .run-observation{display:flex;align-items:baseline;justify-content:space-between;gap:6px 16px;flex-wrap:wrap;font-size:12px;color:var(--text-dim)}
.plugin-run-history .run-row{padding:16px 0;border-bottom:1px solid var(--line);display:grid;gap:6px;overflow-wrap:anywhere;min-width:0}
.plugin-run-history .run-open{justify-self:start;border:0;padding:0;background:transparent;min-height:28px;border-radius:3px;text-align:left;font-weight:600;font-size:15px;line-height:1.4;max-width:100%;overflow-wrap:anywhere}
.plugin-run-history .run-open:hover:not(:disabled){background:transparent;color:var(--accent-text,var(--accent));text-decoration:underline;text-underline-offset:3px}
.plugin-run-history .run-identity{display:flex;gap:6px 12px;flex-wrap:wrap;align-items:center;font-size:12px}
.plugin-run-history .run-identity:empty{display:none}
.plugin-run-history .run-metadata{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;font-size:12px}
.plugin-run-history :is(.run-worker,.run-recommendation,.run-settlement){display:inline-flex;align-items:center;gap:5px}
.plugin-run-history .run-worker[data-status=running]{color:var(--info-text,var(--accent-text,var(--accent)))}
.plugin-run-history .run-worker[data-status=succeeded]{color:var(--good-text,var(--good))}
.plugin-run-history .run-worker[data-status=failed]{color:var(--bad-text,var(--bad))}
.plugin-run-history .run-settlement>.run-icon{color:var(--bad)}
.plugin-run-history .run-icon{font-family:"Helmsman Phosphor Regular";font-weight:400;font-size:16px;line-height:1;display:inline-block;flex:none}
.plugin-run-history .run-details{font-size:12px;min-width:0;margin-top:2px}
.plugin-run-history .run-details>summary{cursor:pointer;color:var(--text-dim);width:fit-content;border-radius:3px;min-height:28px;align-content:center}
.plugin-run-history .run-details>summary:hover{color:var(--text)}
.plugin-run-history .run-evidence{display:grid;gap:6px;padding:10px 12px;margin-top:6px;background:var(--panel-2,var(--face-hi));border-left:1px solid var(--line-strong);border-radius:0 6px 6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:700px){.plugin-run-history .run-observation{display:grid;gap:4px}.plugin-run-history .run-tools{gap:10px}}
@media(pointer:coarse){.plugin-run-history :is(button,select),.plugin-run-history .run-details>summary{min-height:44px}}
@media(prefers-reduced-motion:reduce){.plugin-run-history button{transition:none}}
`;

const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-clarifications{color:var(--text);font:14px/1.5 var(--sans,sans-serif);display:grid;gap:20px;min-width:0}
.plugin-clarifications :is(h1,h2,h3,p){margin:0}
.plugin-clarifications :is(h1,h2,h3){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}
.plugin-clarifications h1{font-size:26px}
.plugin-clarifications h2{font-size:20px;display:flex;align-items:center;gap:8px}
.plugin-clarifications h3{font-size:16px}
.plugin-clarifications[data-composition-page]>.composition-page-header{margin-bottom:0}
.plugin-clarifications .question-page-recovery{justify-self:start;font-size:12px}
.plugin-clarifications a{color:var(--accent-text,var(--accent));text-underline-offset:3px;text-decoration-thickness:1px;overflow-wrap:anywhere}
.plugin-clarifications a:hover{color:var(--accent-text-hover,var(--accent-text,var(--accent)))}
.plugin-clarifications-panel{gap:14px}
.plugin-clarifications-panel :is(article,form){display:grid;gap:10px;min-width:0}
.plugin-clarifications-panel article{padding:16px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-clarifications-panel .question-row:first-of-type{padding-top:0}
.plugin-clarifications-panel :is(button,input,textarea,select){font:14px/1.4 var(--sans,sans-serif);color:var(--text);background:var(--panel-hi,var(--face-hi));border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;max-width:100%;box-sizing:border-box;min-height:32px}
.plugin-clarifications-panel :is(input,textarea,select){color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-clarifications-panel textarea{width:100%;min-height:90px;resize:vertical}
.plugin-clarifications-panel label{display:grid;gap:5px;font-size:12px;font-weight:600;color:var(--text-dim)}
.plugin-clarifications-panel button{cursor:pointer;justify-self:start;display:inline-flex;align-items:center;gap:6px;transition:background-color 160ms ease-out,border-color 160ms ease-out}
.plugin-clarifications-panel button:hover:not(:disabled){background:var(--face-hi);border-color:var(--accent-text,var(--accent))}
.plugin-clarifications-panel button:disabled{opacity:.5;cursor:default}
.plugin-clarifications .question-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-clarifications .question-pagination{font-size:12px;color:var(--text-dim)}
.plugin-clarifications-panel :is(button,input,textarea,select,summary,a):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.plugin-clarifications-panel [role=alert]{color:var(--bad-text,var(--bad));padding:10px 12px;background:var(--panel-2,var(--face-hi));border-radius:6px}
.plugin-clarifications :is(small,.question-observation){color:var(--text-dim);font-size:12px;overflow-wrap:anywhere}
.plugin-clarifications-panel :is(p,small){line-height:1.5;overflow-wrap:anywhere}
.plugin-clarifications-panel p{max-width:75ch}
.plugin-clarifications-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:inherit}
.plugin-clarifications-panel .question-accepted{white-space:pre-wrap}
.plugin-clarifications-panel .question-empty{padding:16px;background:var(--panel-2,var(--panel));border:1px solid var(--line);border-radius:12px;display:grid;gap:5px}
.plugin-clarifications-panel .question-empty p{font-weight:600}
.plugin-clarifications-panel .question-read-only{font-size:12px;color:var(--text-dim)}
.plugin-clarifications-panel .question-row[data-blocking=true] .question-read-only{color:var(--bad-text,var(--bad))}
.plugin-clarifications-panel .question-answer-draft[open]{display:grid;gap:10px;min-width:0}
.plugin-clarifications-panel .primary-action{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.plugin-clarifications-panel .primary-action:hover:not(:disabled){background:var(--accent-bright,var(--accent));border-color:var(--accent-bright,var(--accent));color:var(--on-accent)}
.plugin-clarifications-panel :is(.question-recovery,.question-saved[open]){display:grid;gap:10px;min-width:0}
.plugin-clarifications-panel .question-recovery{border-top:1px solid var(--line);padding-top:16px}
.plugin-clarifications-panel summary{cursor:pointer;color:var(--text-dim);font-size:12px;min-height:28px;align-content:center;width:fit-content;border-radius:3px}
.question-icon{font-family:"Helmsman Phosphor Regular";font-weight:400;font-size:18px;line-height:1;display:inline-block;flex:none}
.question-icon::before{content:attr(data-glyph)}
@media(pointer:coarse){.plugin-clarifications-panel :is(button,input,select,summary){min-height:44px}}
@media(prefers-reduced-motion:reduce){.plugin-clarifications-panel button{transition:none}}
`;

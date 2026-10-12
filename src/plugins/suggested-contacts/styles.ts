const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-suggested-contacts{color:var(--text);font:14px/1.5 var(--sans,sans-serif);display:grid;gap:16px;min-width:0;background:var(--panel-2,var(--panel));border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.plugin-suggested-contacts :is(h2,h3,p){margin:0}
.plugin-suggested-contacts :is(h2,h3){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}
.plugin-suggested-contacts h2{font-size:18px;display:flex;align-items:center;gap:8px;white-space:nowrap;text-wrap:nowrap;flex-shrink:0}
.plugin-suggested-contacts h3{font-size:15px}
.plugin-suggested-contacts :is(section,article,form,details[open]){display:grid;gap:10px;min-width:0}
.plugin-suggested-contacts .contact-section-heading{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}
.plugin-suggested-contacts .contact-global{font-size:11px;border:1px solid var(--line-strong);border-radius:999px;padding:1px 7px;color:var(--text-dim)}
.plugin-suggested-contacts .contact-intro{font-size:12px;color:var(--text-dim)}
.plugin-suggested-contacts .contact-form{max-width:720px;width:100%;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:10px 16px;align-items:start}
.plugin-suggested-contacts label{display:grid;gap:5px;font-size:12px;font-weight:600;color:var(--text-dim)}
.plugin-suggested-contacts :is(button,input){font:14px/1.4 var(--sans,sans-serif);color:var(--text);background:var(--panel-hi,var(--face-hi));border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;max-width:100%;box-sizing:border-box;min-height:32px}
.plugin-suggested-contacts input:not([type=checkbox]){width:100%;color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-suggested-contacts button{cursor:pointer;justify-self:start;display:inline-flex;align-items:center;gap:6px;transition:background-color 160ms ease-out,border-color 160ms ease-out}
.plugin-suggested-contacts button:hover:not(:disabled){background:var(--face-hi);border-color:var(--accent-text,var(--accent))}
.plugin-suggested-contacts button:disabled{opacity:.5;cursor:default}
.plugin-suggested-contacts .contact-form :is(.contact-enabled,button){grid-column:1/-1}
.plugin-suggested-contacts .contact-enabled{display:flex;align-items:center;gap:8px;font-weight:400;color:var(--text);min-height:28px;width:fit-content;cursor:pointer}
.plugin-suggested-contacts .contact-enabled input{margin:0;min-height:0;width:16px;height:16px;accent-color:var(--accent)}
.plugin-suggested-contacts .primary-action{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.plugin-suggested-contacts .primary-action:hover:not(:disabled){background:var(--accent-bright,var(--accent));border-color:var(--accent-bright,var(--accent));color:var(--on-accent)}
.plugin-suggested-contacts :is(button,input,summary,a):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.plugin-suggested-contacts a{color:var(--accent-text,var(--accent));text-underline-offset:3px;text-decoration-thickness:1px;overflow-wrap:anywhere;font-size:12px;justify-self:start}
.plugin-suggested-contacts [role=alert]{color:var(--bad-text,var(--bad));font-size:14px}
.plugin-suggested-contacts :is(small,p){line-height:1.5;overflow-wrap:anywhere}
.plugin-suggested-contacts small{color:var(--text-dim);font-size:12px}
.plugin-suggested-contacts p{max-width:75ch}
.plugin-suggested-contacts :is(.contact-list,.contact-edit,.contact-recovery){border-top:1px solid var(--line);padding-top:14px}
.plugin-suggested-contacts .contact-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--line-faint,var(--line));overflow-wrap:anywhere}
.plugin-suggested-contacts .contact-row p{grid-column:1;font-size:12px;color:var(--text-dim)}
.plugin-suggested-contacts .contact-row button{grid-column:2;grid-row:1/3;align-self:center}
.plugin-suggested-contacts .contact-edit{gap:10px}
.plugin-suggested-contacts .contact-recovery article,.plugin-suggested-contacts .contact-saved article{padding:12px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-suggested-contacts .question-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--text-dim)}
.plugin-suggested-contacts summary{cursor:pointer;color:var(--text-dim);font-size:12px;min-height:28px;align-content:center;width:fit-content;border-radius:3px}
.plugin-suggested-contacts .question-icon{font-family:"Helmsman Phosphor Regular";font-weight:400;font-size:18px;line-height:1;display:inline-block;flex:none}
.plugin-suggested-contacts .question-icon::before{content:attr(data-glyph)}
@media(max-width:600px){.plugin-suggested-contacts{padding:16px}.plugin-suggested-contacts .contact-form{grid-template-columns:1fr}.plugin-suggested-contacts .contact-row{grid-template-columns:1fr}.plugin-suggested-contacts .contact-row button{grid-column:1;grid-row:auto}}
@media(pointer:coarse){.plugin-suggested-contacts :is(button,input:not([type=checkbox]),summary,.contact-enabled){min-height:44px}}
@media(prefers-reduced-motion:reduce){.plugin-suggested-contacts button{transition:none}}
`;

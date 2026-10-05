export const styles = `
.plugin-suggested-contacts{color:var(--text);font:14px var(--sans,sans-serif);display:grid;gap:12px;min-width:0}
.plugin-suggested-contacts :is(h1,h2,h3,p){margin:0}
.plugin-suggested-contacts :is(section,article,form,details[open]){display:grid;gap:12px;min-width:0}
.plugin-suggested-contacts article{padding:14px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-suggested-contacts :is(button,input,textarea,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:7px 10px;max-width:100%;box-sizing:border-box}
.plugin-suggested-contacts :is(input:not([type=checkbox]):not([type=radio]),textarea,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-suggested-contacts textarea{width:100%;min-height:90px;resize:vertical}
.plugin-suggested-contacts input:not([type=checkbox]){width:100%}
.plugin-suggested-contacts label{display:grid;gap:5px}
.plugin-suggested-contacts button{cursor:pointer}
.plugin-suggested-contacts button:disabled{opacity:.5;cursor:default}
.plugin-suggested-contacts .question-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-suggested-contacts :is(button,input,textarea,select):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-suggested-contacts [role=alert]{color:var(--bad)}
.plugin-suggested-contacts small{color:var(--text-dim)}
.plugin-suggested-contacts pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:inherit}
.plugin-suggested-contacts .contact-enabled{display:flex;align-items:center;gap:8px}
.plugin-suggested-contacts .contact-enabled input{margin:0}
.plugin-suggested-contacts { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-suggested-contacts :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-suggested-contacts h1 { font-size: 24px; }
.plugin-suggested-contacts h2 { font-size: 18px; }
.plugin-suggested-contacts h3 { font-size: 16px; }
.plugin-suggested-contacts :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-suggested-contacts button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-suggested-contacts button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-suggested-contacts button:disabled { cursor: default; opacity: .5; }
.plugin-suggested-contacts :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-suggested-contacts :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-suggested-contacts :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-suggested-contacts small { font-size: 12px; }
.plugin-suggested-contacts p { max-width: 75ch; }
.plugin-suggested-contacts :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-suggested-contacts :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-suggested-contacts button { transition: none; }
 }
`;

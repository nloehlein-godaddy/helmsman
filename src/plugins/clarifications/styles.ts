export const styles = `
.plugin-clarifications{color:var(--text);font:16px var(--sans,sans-serif);display:grid;gap:12px;min-width:0}
.plugin-clarifications :is(h1,h2,h3,p){margin:0}
.plugin-clarifications :is(section,article,form,details[open]){display:grid;gap:12px;min-width:0}
.plugin-clarifications article{padding:14px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-clarifications :is(button,input,textarea,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:7px 10px;max-width:100%;box-sizing:border-box}
.plugin-clarifications :is(input:not([type=checkbox]):not([type=radio]),textarea,select){background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-clarifications textarea{width:100%;min-height:90px;resize:vertical}
.plugin-clarifications input:not([type=checkbox]){width:100%}
.plugin-clarifications label{display:grid;gap:5px}
.plugin-clarifications button{cursor:pointer}
.plugin-clarifications button:disabled{opacity:.5;cursor:default}
.plugin-clarifications .question-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-clarifications :is(button,input,textarea,select):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-clarifications [role=alert]{color:var(--bad)}
.plugin-clarifications small{color:var(--text-dim)}
.plugin-clarifications pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:inherit}
.plugin-clarifications { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-clarifications :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-clarifications h1 { font-size: 26px; }
.plugin-clarifications h2 { font-size: 20px; }
.plugin-clarifications h3 { font-size: 18px; }
.plugin-clarifications :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-clarifications button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-clarifications button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-clarifications button:disabled { cursor: default; opacity: .5; }
.plugin-clarifications :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-clarifications :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-clarifications :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-clarifications small { font-size: 14px; }
.plugin-clarifications p { max-width: 75ch; }
.plugin-clarifications :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-clarifications :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-clarifications button { transition: none; }
 }
`;

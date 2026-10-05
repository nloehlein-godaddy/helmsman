export const styles = `
.execution-settings { padding:1rem; max-width:54rem; }
.execution-settings label { display:block; margin:1rem 0; }
.execution-settings input[type=number] { display:block; padding:.5rem; max-width:7rem; color:var(--text); background-color:var(--control-bg,var(--panel)); border:1px solid var(--control-border,var(--line)); }
.execution-settings button { margin:.5rem .5rem .5rem 0; min-height:2.25rem; }
.execution-settings p { line-height:1.5; overflow-wrap:anywhere; }
.execution-settings [role=alert] { color:var(--bad); }
.execution-settings { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.execution-settings :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.execution-settings h1 { font-size: 24px; }
.execution-settings h2 { font-size: 18px; }
.execution-settings h3 { font-size: 16px; }
.execution-settings :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.execution-settings button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.execution-settings button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.execution-settings button:disabled { cursor: default; opacity: .5; }
.execution-settings :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.execution-settings :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.execution-settings :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.execution-settings small { font-size: 12px; }
.execution-settings p { max-width: 75ch; }
.execution-settings :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.execution-settings :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .execution-settings button { transition: none; }
 }
`;

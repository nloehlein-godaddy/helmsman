export const styles = `
.campaign-page { padding: 1rem; min-width: 0; }
.campaign-layout > *, .campaign-page form, .campaign-page label, .campaign-settings, .campaign-settings > div { min-width: 0; }
.campaign-layout { display: grid; grid-template-columns: minmax(15rem, 1fr) minmax(0, 3fr); gap: 1rem; align-items: start; }
.campaign-panel { padding: 1rem; margin-bottom: 1rem; }
.campaign-page fieldset { border: 0; padding: 0; display: grid; gap: .8rem; min-width: 0; }
.campaign-page label { display: grid; gap: .3rem; }
.campaign-page input, .campaign-page select, .campaign-page textarea { width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; font: inherit; color: var(--text); background-color: var(--control-bg, var(--bg)); border: 1px solid var(--control-border, var(--line)); border-radius: 6px; padding: .55rem; }
.campaign-page button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .45rem .65rem; max-width: 100%; white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.campaign-page button:hover, .campaign-page button[aria-pressed="true"] { border-color: var(--accent); }
.campaign-page button:disabled { opacity: .5; cursor: default; }
.campaign-list { list-style: none; padding: 0; display: grid; gap: .7rem; }
.campaign-list small, .campaign-page td small { display: block; margin-top: .3rem; overflow-wrap: anywhere; }
.campaign-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
.campaign-hint { font-size: .8rem; color: var(--text-dim); }
.campaign-state { font-size: .8rem; font-weight: normal; }
.campaign-error { color: var(--bad); overflow-wrap: anywhere; }
.campaign-preview, .campaign-confirm { border: 1px solid var(--accent); padding: .8rem; margin: 1rem 0; }
.campaign-preview ol { max-height: 24rem; overflow: auto; padding-left: 1.5rem; }
.campaign-preview li { white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: .6rem; }
.campaign-table-wrap { overflow: auto; margin-top: 1rem; }
.campaign-page table { border-collapse: collapse; width: 100%; text-align: left; }
.campaign-page th, .campaign-page td { padding: .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.campaign-page button:focus-visible, .campaign-page input:focus-visible, .campaign-page select:focus-visible, .campaign-page textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.campaign-page td:first-child { min-width: 10rem; max-width: 30rem; overflow-wrap: anywhere; }
@media (max-width: 850px) { .campaign-layout { grid-template-columns: minmax(0, 1fr); }
 }
.campaign-page h1 { margin: 0 0 7px; font-size: 18px; }
.campaign-page > p:not(.campaign-error) { max-width: 75ch; margin: 0 0 18px; color: var(--text-dim); font-size: 12px; line-height: 1.6; }
.campaign-page h2 { margin: 0 0 12px; font-size: 14px; overflow-wrap: anywhere; }
.campaign-page h3 { margin: 0 0 8px; font-size: 14px; overflow-wrap: anywhere; }
.campaign-page form + h2 { margin-top: 24px; }
.campaign-detail > form { margin: 18px 0; }
.campaign-settings { font-size: 12px; margin: 0 0 8px; }
.campaign-settings summary { cursor: pointer; color: var(--text-dim); }
.campaign-settings > div { display: grid; gap: 12px; padding-top: 12px; }
.campaign-hint { line-height: 1.6; }
.campaign-page .campaign-primary { color: var(--accent); border-color: var(--accent); }
.campaign-page .campaign-destructive { color: var(--bad); }
.campaign-page .campaign-confirm button + button { margin-left: 8px; }
.campaign-settings summary:focus-visible, .campaign-table-wrap:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.campaign-recovery {padding:1rem;}
.campaign-recovery article {border-top:1px solid var(--line-faint);padding:.75rem 0;overflow-wrap:anywhere;}
.campaign-scope {display:flex;gap:.5rem;flex-wrap:wrap;padding:1rem;}
.campaign-page { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.campaign-page :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.campaign-page h1 { font-size: 24px; }
.campaign-page h2 { font-size: 18px; }
.campaign-page h3 { font-size: 16px; }
.campaign-page :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.campaign-page button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.campaign-page button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.campaign-page button:disabled { cursor: default; opacity: .5; }
.campaign-page :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.campaign-page :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.campaign-page :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.campaign-page small { font-size: 12px; }
.campaign-page p { max-width: 75ch; }
.campaign-page :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.campaign-page :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .campaign-page button { transition: none; }
 }
.campaign-page .campaign-panel { padding: 16px 0; }
.campaign-page :is(.campaign-preview,.campaign-confirm) { border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.campaign-page > p:not(.campaign-error) { font-size: 14px; }
.campaign-page .campaign-settings { font-size: 14px; }
`;

export const styles = `
.plugin-jira-settings { padding: 1rem; min-width: 0; }
.plugin-jira-settings label { display: grid; gap: .4rem; margin: 1rem 0; max-width: 44rem; }
.plugin-jira-settings input, .plugin-jira-settings select { width: 100%; box-sizing: border-box; min-width: 0; padding: .65rem; color: var(--text); background-color: var(--control-bg, var(--panel)); border: 1px solid var(--control-border, var(--line)); border-radius: 6px; font: inherit; }
.plugin-jira-settings .settings-tools { display: flex; gap: .5rem; flex-wrap: wrap; margin: 1rem 0; }
.plugin-jira-settings button { white-space: normal; min-height: 2.25rem; }
.plugin-jira-settings p { max-width: 60rem; line-height: 1.6; overflow-wrap: anywhere; }
.plugin-jira-settings [role="alert"] { color: var(--bad); }
.plugin-jira-settings input:focus-visible, .plugin-jira-settings select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-jira-settings { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-jira-settings :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-jira-settings h1 { font-size: 26px; }
.plugin-jira-settings h2 { font-size: 20px; }
.plugin-jira-settings h3 { font-size: 18px; }
.plugin-jira-settings :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-jira-settings button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-jira-settings button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-jira-settings button:disabled { cursor: default; opacity: .5; }
.plugin-jira-settings :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-jira-settings :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-jira-settings :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-jira-settings small { font-size: 14px; }
.plugin-jira-settings p { max-width: 75ch; }
.plugin-jira-settings :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-jira-settings :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-jira-settings button { transition: none; }
 }
`;

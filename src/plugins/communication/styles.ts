export const styles = `
.plugin-communication { position: relative; flex-shrink: 0; }
.slack-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 34px; min-height: 34px; padding: 6px 8px; border: 1px solid var(--line-faint); border-radius: 6px; background: var(--rail); color: var(--text-dim); font: 16px var(--sans, sans-serif); cursor: pointer; }
.slack-toggle svg { width: 16px; height: 16px; }
.slack-toggle.has-unread { color: var(--accent-text,var(--accent)); border-color: var(--line-strong);  }
@media (prefers-reduced-motion: reduce) { .slack-toggle.has-unread { animation: none; }
 }
.slack-count { min-width: 17px; padding: 1px 4px; border-radius: 3px; background: var(--accent); color: var(--on-accent); font-weight: 700; }
.slack-popover { position: absolute; right: 0; top: calc(100% + 12px); z-index: 50; width: 420px; max-width: calc(100vw - 40px); max-height: min(620px, 75vh); overflow-y: auto; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--face); box-shadow: 0 12px 32px #0009; text-align: left; }
.slack-popover-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 8px; }
.slack-popover-head h2 { flex: 1; margin: 0; color: var(--text); font: 600 20px var(--sans,sans-serif); text-transform: none; letter-spacing: -.02em; }
.slack-popover button { cursor: pointer; color: var(--text-dim); border: 1px solid var(--line-faint); background: var(--rail); border-radius: 6px; padding: 4px 7px; font: 16px var(--sans, sans-serif); }
.slack-popover button:hover, .slack-toggle:hover { color: var(--accent-text,var(--accent)); border-color: var(--line-strong); }
.plugin-communication button:focus-visible, .plugin-communication a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.slack-popover-head button { font-size: 20px; line-height: 1; }
.slack-popover-head [data-clear-notifications] { order: 1; width: 100%; font-size: 14px; line-height: 1.4; }
.slack-popover button:disabled { opacity: .6; cursor: default; }
.slack-health { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 0 16px 14px; font-size: 14px; color: var(--text-dim); border-bottom: 1px solid var(--line-faint); }
.slack-health strong { color: var(--text-dim); }
.slack-health + .slack-health { padding-top: 12px; }
.slack-health .slack-error { flex-basis: 100%; }
.slack-notification-list { list-style: none; padding: 0; margin: 0; }
.slack-notification { padding: 14px 16px; border-bottom: 1px solid var(--line-faint); border-left: 1px solid transparent; }
.slack-notification:last-child { border-bottom: 0; }
.slack-notification.is-unread { border-left-color: var(--accent); background: var(--face-2); }
.slack-notification-top { display: flex; align-items: baseline; justify-content: space-between; gap:12px; }
.slack-status { font-size: 14px; color: var(--queued); }
.slack-status--launched, .slack-status--succeeded { color: var(--good); }
.slack-status--stopped { color: var(--text-dim); }
.slack-status--failed, .slack-status--blocked, .slack-error, .slack-action-error { color: var(--bad); }
.slack-notification time { color: var(--text-dim); font-size: 14px; white-space: nowrap; }
.slack-pr { margin-top: 7px; overflow-wrap: anywhere; font: 16px var(--sans, sans-serif); }
.slack-voyage-title { margin-top: 7px; color: var(--text); overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; }
.slack-popover a { color: var(--text); text-underline-offset: 3px; }
.slack-popover a:hover { color: var(--accent-text,var(--accent)); }
.slack-author { margin-top: 5px; font-size: 14px; color: var(--text-dim); overflow-wrap: anywhere; }
.slack-routing { margin-top: 7px; font: 16px var(--sans, sans-serif); color: var(--text-dim); overflow-wrap: anywhere; }
.slack-error { font-size: 14px; overflow-wrap: anywhere; }
.slack-notification-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; font-size: 14px; }
.slack-notification-actions button, .slack-read { margin-left: auto; }
.slack-read { color: var(--text-dim); }
.slack-action-error, .slack-empty { margin: 0; padding: 16px; font-size: 14px; }
.slack-empty { color: var(--text-dim); }
@media (max-width: 700px) { .slack-popover { position: fixed; top: 100px; right: 20px; }
 }
.slack-review-control { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.communication-request .slack-review-control { margin-left: auto; }
.slack-review-request { color: var(--accent-text,var(--accent)); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 6px; padding: 7px 10px; font: 16px var(--sans, sans-serif); cursor: pointer; }
.slack-review-request:disabled { opacity: .6; cursor: default; }
.slack-review-request:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.slack-review-result { font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.slack-review-result.is-error { color: var(--bad); }
.plugin-communication { min-width:0; position:relative; }
.communication-page {min-width:0;}
.communication-page .slack-popover {position:static;width:100%;max-width:none;max-height:none;box-shadow:none;}
.communication-settings {display:grid;gap:.75rem;padding:1rem;min-width:0;}
.communication-settings label {display:grid;gap:.35rem;min-width:0;}
.communication-settings input,.communication-settings select {width:100%;min-width:0;}
.communication-tools {display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;}
.communication-request {padding:1rem;min-width:0;overflow-wrap:anywhere;}
.communication-request input {width:100%;min-width:0;}
.communication-request article {margin-block:1rem;border-top:1px solid var(--line);padding-top:.75rem;}
.communication-destination {overflow-wrap:anywhere;}
.plugin-communication { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-communication :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-communication h1 { font-size: 26px; }
.plugin-communication h2 { font-size: 20px; }
.plugin-communication h3 { font-size: 18px; }
.plugin-communication :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-communication button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-communication button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-communication button:disabled { cursor: default; opacity: .5; }
.plugin-communication :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-communication :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-communication :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-communication small { font-size: 14px; }
.plugin-communication p { max-width: 75ch; }
.plugin-communication :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-communication :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-communication button { transition: none; }
 }
.plugin-communication .slack-popover { border: 0; border-radius: 12px; box-shadow: 0 12px 32px #0003; }
.communication-page .slack-popover { border: 0; border-radius: 0; box-shadow: none; }
.plugin-communication .slack-popover-head [data-clear-notifications] { font-size: 16px; }
.plugin-communication .slack-voyage-title { font-size: 16px; font-weight: 600; }
`;

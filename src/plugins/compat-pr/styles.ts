export const styles = `
.plugin-public-pr .pr-inbox-grid { width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 16px 0; }
.plugin-public-pr .pr-list-panel { min-width: 0; align-self: start; }
.plugin-public-pr .pr-list-github { color: var(--accent); text-underline-offset: 3px; }
.plugin-public-pr .pr-list-github:hover { color: var(--accent-bright); }
.plugin-public-pr .pr-list-count { margin-left: auto; font-size: 14px; color: var(--text-dim); }
.plugin-public-pr .pr-list { max-height: 360px; overflow-y: auto; container: pr-list / inline-size; }
.plugin-public-pr .pr-list-row { display:grid; grid-template-columns:7ch minmax(0,1fr) auto; align-items:start; gap:12px; padding:14px; }
.plugin-public-pr .pr-list-summary { grid-column:2;grid-row:1; display: flex; flex-direction: column; min-width: 0; gap: 5px; }
.plugin-public-pr .pr-list-summary .queue-title { white-space: normal; overflow-wrap: anywhere; }
.plugin-public-pr .pr-list-summary .agent-repo { white-space: normal; overflow-wrap: anywhere; }
.plugin-public-pr .pr-list-stats { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; color: var(--text-dim); font-size: 14px; line-height: 1.4; }
.plugin-public-pr .pr-list-stat { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.plugin-public-pr .pr-list-stat svg { width: 12px; height: 12px; flex: 0 0 12px; }
.plugin-public-pr .pr-lookup-form { display: flex; gap: 8px; padding: 12px 14px; }
.plugin-public-pr .pr-lookup-input { flex: 1; min-width: 0; }
.plugin-public-pr .pr-lookup-result { padding: 0 14px 12px; }
.plugin-public-pr .pr-open-in-tab { margin-left: auto; font-size: 14px; }
.plugin-public-pr .pr-diff { padding: 4px 14px 12px; display: flex; flex-direction: column; gap: 6px; }
.plugin-public-pr .diff-file { min-width: 0; border: 1px solid var(--line-faint); background: var(--panel-2); }
.plugin-public-pr .diff-file-head { display: flex; align-items: center; justify-content: space-between; gap:12px; padding: 6px 10px; cursor: pointer; font-size: 14px; }
.plugin-public-pr .diff-file-name { min-width: 0; overflow-wrap: anywhere; color: var(--text-dim); }
.plugin-public-pr .diff-file-stat { display: inline-flex; gap: 8px; }
.plugin-public-pr .diff-patch { margin: 0; padding: 8px 10px; overflow-x: auto; font-size: 14px; line-height: 1.45; border-top: 1px solid var(--line-faint); }
.plugin-public-pr .diff-line { display: block; white-space: pre; }
.plugin-public-pr .diff-add { color: var(--good); }
.plugin-public-pr .diff-del { color: var(--bad); }
.plugin-public-pr .diff-hunk { color: var(--accent); }
.plugin-public-pr .diff-ctx { color: var(--text-dim); }
.plugin-public-pr .diff-nopatch { padding: 8px 10px; border-top: 1px solid var(--line-faint); }
.plugin-public-pr .pr-panel { border: 1px solid var(--line); background: var(--panel-2); padding: 12px; display: flex; flex-direction: column; gap: 11px; margin-top: 6px; }
.plugin-public-pr .pr-panel.empty-note { color: var(--text-dim); }
.plugin-public-pr .pr-panel-head { display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid var(--line-faint); padding-bottom: 12px; }
.plugin-public-pr .pr-panel-heading, .plugin-public-pr .pr-panel-meta { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap; }
.plugin-public-pr .pr-panel-identity { flex: 1 1 240px; min-width: 0; }
.plugin-public-pr .pr-panel-title { margin: 0 0 6px; font-size: 18px; line-height: 1.4; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.plugin-public-pr .pr-panel-byline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; min-width: 0; }
.plugin-public-pr .pr-author { font-size: 14px; color: var(--text-dim); overflow-wrap: anywhere; }
.plugin-public-pr .pr-panel-status { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 6px; margin-left: auto; max-width: 100%; }
.plugin-public-pr .pr-panel-status .chip { white-space: normal; }
.plugin-public-pr .pr-panel-context { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px; min-width: 0; flex: 0 1 auto; }
.plugin-public-pr .pr-meta-label { color: var(--text-dim); margin-right: 6px; }
.plugin-public-pr .pr-panel-timing { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 24px; font-size: 14px; color: var(--text); }
.plugin-public-pr .pr-panel-timing > span { min-width: 0; }
.plugin-public-pr .pr-panel-timing time { display: inline-block; }
.plugin-public-pr .pr-review-freshness { color: var(--text-dim); }
.plugin-public-pr .pr-crew-controls { display: flex; flex-direction: column; gap: 8px; }
.plugin-public-pr .pr-voyage-links { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.plugin-public-pr .pr-ci { font-size: 14px; color: var(--good); }
.plugin-public-pr .pr-ci-bad { color: var(--bad); }
.plugin-public-pr .pr-branch, .plugin-public-pr .pr-comments { min-width: 0; overflow-wrap: anywhere; font-size: 14px; color: var(--text-dim); }
.plugin-public-pr .pr-link { overflow-wrap: anywhere; font-family: var(--mono); font-size: 14px; color: var(--accent); text-decoration: none; }
.plugin-public-pr .pr-link:hover { color: var(--accent-bright); }
.plugin-public-pr .pr-review { display: flex; flex-direction: column; gap: 7px; }
.plugin-public-pr .pr-review-body, .plugin-public-pr .pr-rerun-feedback { width: 100%; min-height: 46px; }
.plugin-public-pr .pr-review-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.plugin-public-pr .pr-request-changes:hover { background: var(--bad); border-color: var(--bad); color: var(--on-accent); }
.plugin-public-pr .pr-review-error { color: var(--bad); font-size: 14px; }
.plugin-public-pr .pr-no-rerun { padding: 8px 0; font-size: 14px; }
.plugin-public-pr { min-width:0; }
.plugin-public-pr > section { margin-block: 1rem; }
.plugin-public-pr h3 { padding:.5rem; }
.plugin-public-pr .pr-lookup-form { flex-wrap:wrap; }
.plugin-public-pr .pr-lookup-form label { flex:1; min-width: 0; }
.plugin-public-pr input { width:100%; min-width:0; }
.plugin-public-pr .pr-inbox { display:grid;grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem;}
.plugin-public-pr .pr-pending {overflow-wrap:anywhere;}
@media(max-width:700px){.plugin-public-pr .pr-inbox{grid-template-columns:1fr;}}
.plugin-public-pr .pr-list-row>.ticket-id{grid-column:1;grid-row:1}
.plugin-public-pr .pr-list-badges{grid-column:3;grid-row:1;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
@container pr-list (max-width:440px){.plugin-public-pr .pr-list-row{grid-template-columns:minmax(0,1fr) auto;gap:12px 12px}
.plugin-public-pr .pr-list-summary{grid-column:1 / -1;grid-row:2}
.plugin-public-pr .pr-list-badges{grid-column:2}}
.plugin-public-pr { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-public-pr :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-public-pr h1 { font-size: 26px; }
.plugin-public-pr h2 { font-size: 20px; }
.plugin-public-pr h3 { font-size: 18px; }
.plugin-public-pr :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-public-pr button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-public-pr button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-public-pr button:disabled { cursor: default; opacity: .5; }
.plugin-public-pr :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-public-pr :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-public-pr :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-public-pr small { font-size: 14px; }
.plugin-public-pr p { max-width: 75ch; }
.plugin-public-pr :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-public-pr :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-public-pr button { transition: none; }
 }
.plugin-public-pr .pr-panel { border: 0; border-top: 1px solid var(--line); background: transparent; padding: 16px 0; gap: 12px; }
.plugin-public-pr .pr-panel-title { font-size: 20px; }
.plugin-public-pr .pr-list-row { padding: 12px; }
.plugin-public-pr .diff-file { border-radius: 6px; overflow: hidden; }
.plugin-public-pr .pr-request-changes:hover:not(:disabled) { background: var(--bad); border-color: var(--bad); color: var(--on-accent); }
`;

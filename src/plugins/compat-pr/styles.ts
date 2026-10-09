export const styles = `
.plugin-public-pr { font:16px/1.5 var(--sans,sans-serif); color:var(--text); min-width:0; display:flex; flex-direction:column; gap:16px; }
.plugin-public-pr [hidden] { display:none!important; }
.plugin-public-pr > section:empty { display:none; }
.plugin-public-pr :is(h3,p,ul) { margin:0; }
.plugin-public-pr h3 { font:600 17px/1.3 var(--sans,sans-serif); letter-spacing:-.02em; padding:0; display:flex; align-items:baseline; gap:12px; }
.plugin-public-pr .panel { min-width:0; padding:16px; background:var(--panel); border:1px solid var(--line); border-radius:12px; }
.plugin-public-pr a { color:var(--accent-text,var(--accent)); overflow-wrap:anywhere; text-underline-offset:3px; }
.plugin-public-pr a:hover { color:var(--accent-text-hover,var(--accent-bright)); }
.plugin-public-pr :is(button,input,select,textarea) { box-sizing:border-box; border-radius:6px; font:16px/1.4 var(--sans,sans-serif); min-height:36px; max-width:100%; }
.plugin-public-pr button { padding:6px 12px; color:var(--text); background:var(--control-bg,var(--panel-2)); border:1px solid var(--control-border,var(--line)); text-transform:none; letter-spacing:normal; }
.plugin-public-pr button:hover:not(:disabled) { background:var(--panel-hi); border-color:var(--line-strong,var(--line)); }
.plugin-public-pr button:disabled { cursor:default; opacity:.5; }
.plugin-public-pr :is(input,select,textarea) { padding:6px 12px; color:var(--input-text,var(--text)); background:var(--control-bg,var(--panel-2)); border:1px solid var(--control-border,var(--line)); min-width:0; }
.plugin-public-pr input::placeholder { color:var(--input-placeholder,var(--text-dim)); }
.plugin-public-pr :is(button,input,select,textarea,summary,a):focus-visible { outline:2px solid var(--accent-text,var(--accent)); outline-offset:2px; }
.plugin-public-pr :is(p,small) { overflow-wrap:anywhere; }
.plugin-public-pr .empty-note { font-size:14px; color:var(--text-dim); }
.plugin-public-pr .pr-panel-tools { display:flex; justify-content:flex-end; }
.plugin-public-pr .pr-lookup-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.plugin-public-pr .pr-lookup-form { display:flex; align-items:flex-end; gap:12px; margin-top:12px; }
.plugin-public-pr .pr-lookup-form label { flex:1; min-width:0; }
.plugin-public-pr .pr-lookup-input { width:100%; }
.plugin-public-pr .pr-scope-override { font-size:14px; color:var(--text-dim); margin-top:8px; }
.plugin-public-pr .pr-inbox { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; gap:16px; }
.plugin-public-pr .pr-inbox .panel { display:flex; flex-direction:column; gap:12px; }
.plugin-public-pr .pr-list-count { margin-left:auto; color:var(--text-dim); font-size:14px; font-weight:400; }
.plugin-public-pr :is(.pr-list,.pr-run-list) { list-style:none; padding:0; }
.plugin-public-pr :is(.pr-list-row,.pr-run-list>li)+:is(.pr-list-row,li) { border-top:1px solid var(--line-faint); }
.plugin-public-pr :is(.pr-list-select,.pr-run-select) { display:flex; flex-direction:column; align-items:flex-start; text-align:left; width:100%; border:0; background:transparent; border-radius:4px; gap:6px; padding:12px 0; }
.plugin-public-pr :is(.pr-list-select,.pr-run-select):hover:not(:disabled) { background:var(--panel-hi); }
.plugin-public-pr .pr-list-title { font-size:17px; line-height:1.4; font-weight:600; overflow-wrap:anywhere; }
.plugin-public-pr :is(.pr-list-meta,.pr-list-stats) { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; font-size:14px; color:var(--text-dim); overflow-wrap:anywhere; }
.plugin-public-pr .pr-list-status { color:var(--text); }
.plugin-public-pr .pr-list-stat { white-space:nowrap; }
.plugin-public-pr .pr-list-github { font-size:14px; align-self:flex-start; }
.plugin-public-pr summary { cursor:pointer; min-height:36px; padding:6px 0; }
.plugin-public-pr .pr-recent-runs>summary { font-size:17px; font-weight:600; }
.plugin-public-pr .pr-recent-runs .pr-list-count { margin-left:8px; }
.plugin-public-pr .pr-list-more>summary { font-size:14px; color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-panel { border-top:1px solid var(--line); margin-top:16px; padding-top:16px; display:flex; flex-direction:column; gap:16px; }
.plugin-public-pr .pr-panel-head { display:flex; flex-direction:column; gap:12px; padding-bottom:16px; border-bottom:1px solid var(--line-faint); }
.plugin-public-pr .pr-panel-title { font-size:18px; overflow-wrap:anywhere; }
.plugin-public-pr :is(.pr-panel-byline,.pr-panel-context,.pr-panel-status,.pr-panel-timing,.pr-voyage-links) { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px 16px; font-size:14px; overflow-wrap:anywhere; }
.plugin-public-pr .pr-panel-timing { color:var(--text-dim); }
.plugin-public-pr :is(.pr-review,.pr-crew-controls) { display:flex; flex-direction:column; gap:12px; }
.plugin-public-pr :is(.pr-review-body,.pr-rerun-feedback) { width:100%; min-height:80px; }
.plugin-public-pr .pr-review-actions { display:flex; flex-wrap:wrap; gap:8px; }
.plugin-public-pr .tuning { display:flex; flex-wrap:wrap; gap:12px; }
.plugin-public-pr .tuning label { flex:1; min-width:160px; }
.plugin-public-pr .pr-review-error { color:var(--bad); font-size:14px; }
.plugin-public-pr .pr-pending { overflow-wrap:anywhere; }
.plugin-public-pr [data-storage-error]:empty { display:none; }
.plugin-public-pr .pr-diff-panel { display:flex; flex-direction:column; gap:12px; }
.plugin-public-pr .pr-diff { display:flex; flex-direction:column; gap:8px; }
.plugin-public-pr .diff-file { min-width:0; border:1px solid var(--line-faint); border-radius:6px; background:var(--panel-2); }
.plugin-public-pr .diff-file-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 12px; font-size:14px; }
.plugin-public-pr .diff-file-name { min-width:0; overflow-wrap:anywhere; }
.plugin-public-pr .diff-file-stat { white-space:nowrap; color:var(--text-dim); }
.plugin-public-pr .diff-file>.empty-note { padding:8px 12px; }
.plugin-public-pr .diff-patch { margin:0; padding:12px; overflow-x:auto; font:14px/1.45 var(--mono,monospace); border-top:1px solid var(--line-faint); }
@media(max-width:700px) { .plugin-public-pr .pr-inbox { grid-template-columns:1fr; } .plugin-public-pr .pr-lookup-form { flex-wrap:wrap; } .plugin-public-pr .pr-lookup-form label { flex-basis:100%; } }
@media(any-pointer:coarse) { .plugin-public-pr :is(button,input,select,summary) { min-height:44px; } }
`;

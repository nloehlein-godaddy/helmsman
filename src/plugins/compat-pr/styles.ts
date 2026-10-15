const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face { font-family:"Helmsman Phosphor Regular"; src:url("${phosphorFontUrl}") format("woff2"); font-weight:400; font-style:normal; font-display:block; }
.plugin-public-pr { font:16px/1.5 var(--sans,sans-serif); color:var(--text); min-width:0; display:flex; flex-direction:column; gap:16px; }
.plugin-public-pr [hidden] { display:none!important; }
.plugin-public-pr .pr-review-recommendation { display:grid; gap:8px; padding:12px; background:var(--panel-2); overflow-wrap:anywhere; }
.plugin-public-pr .pr-review-recommendation h4 { display:flex; align-items:center; gap:8px; margin:0; }
.plugin-public-pr .pr-review-recommendation p { white-space:pre-wrap; }
.plugin-public-pr > section:empty { display:none; }
.plugin-public-pr :is(h3,p,ul) { margin:0; }
.plugin-public-pr h3 { font:600 17px/1.3 var(--sans,sans-serif); letter-spacing:-.02em; padding:0; display:flex; align-items:center; gap:8px; }
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
.plugin-public-pr .pr-inbox .pr-list-section { display:block; }
.plugin-public-pr .pr-list-section>summary .pr-list-heading { flex:1; min-width:0; }
.plugin-public-pr .pr-list-section[open]>summary { margin-bottom:12px; }
.plugin-public-pr .pr-list-section>.pr-list-notice { margin-top:12px; }
.plugin-public-pr .pr-list-section>.pr-list-github { display:inline-block; margin-top:12px; }
.plugin-public-pr .pr-list-count { margin-left:auto; color:var(--text-dim); font-size:14px; font-weight:400; }
.plugin-public-pr .pr-authored-filters { display:flex; gap:6px; margin:12px 0 4px; }
.plugin-public-pr .pr-authored-filters button { min-height:32px; padding:4px 12px; font-size:14px; }
.plugin-public-pr .pr-authored-filters button[aria-pressed=true] { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
.plugin-public-pr :is(.pr-list,.pr-run-list) { list-style:none; padding:0; }
.plugin-public-pr :is(.pr-list-row,.pr-run-list>li)+:is(.pr-list-row,li) { border-top:1px solid var(--line-faint); }
.plugin-public-pr :is(.pr-list-select,.pr-run-select) { display:flex; flex-direction:column; align-items:flex-start; text-align:left; width:100%; border:0; background:transparent; border-radius:4px; gap:6px; padding:12px 0; }
.plugin-public-pr :is(.pr-list-select,.pr-run-select):hover:not(:disabled) { background:var(--panel-hi); }
.plugin-public-pr .pr-list-row[data-feedback] { --feedback-color:var(--review); border-inline-start:1px solid var(--feedback-color); background:color-mix(in srgb,var(--feedback-color) 5%,var(--panel)); }
.plugin-public-pr .pr-list-row[data-feedback=changes] { --feedback-color:var(--bad); }
.plugin-public-pr .pr-list-row[data-feedback] .pr-list-select { padding-inline:12px; border-radius:0; }
.plugin-public-pr .pr-list-feedback { display:flex; flex-wrap:wrap; gap:6px 8px; }
.plugin-public-pr .pr-feedback-badge { display:inline-flex; align-items:center; gap:5px; padding:2px 6px; border:1px solid color-mix(in srgb,var(--feedback-color) 45%,var(--line)); border-radius:4px; font-size:13px; line-height:1.4; color:var(--feedback-color); background:color-mix(in srgb,var(--feedback-color) 6%,var(--panel)); }
.plugin-public-pr .pr-feedback-badge[data-tone=bad] { --feedback-color:var(--bad); }
.plugin-public-pr .pr-feedback-badge[data-tone=review] { --feedback-color:var(--review); }
.plugin-public-pr .pr-list-title { font-size:17px; line-height:1.4; font-weight:600; overflow-wrap:anywhere; }
.plugin-public-pr :is(.pr-list-meta,.pr-list-stats) { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; font-size:14px; color:var(--text-dim); overflow-wrap:anywhere; }
.plugin-public-pr :is(.pr-list-status,.pr-draft) { display:inline-flex; align-items:center; gap:5px; color:var(--text); }
.plugin-public-pr .pr-list-stat { white-space:nowrap; }
.plugin-public-pr .pr-request-origin { display:inline-flex; align-items:baseline; gap:5px; min-width:0; color:var(--text-dim); }
.plugin-public-pr .pr-request-origin .pr-phosphor { align-self:center; flex-shrink:0; }
.plugin-public-pr .pr-list-github { font-size:14px; align-self:flex-start; }
.plugin-public-pr summary { cursor:pointer; min-height:36px; padding:6px 0; display:flex; align-items:center; gap:14px; list-style:none; box-sizing:border-box; }
.plugin-public-pr summary::-webkit-details-marker { display:none; }
.plugin-public-pr summary>.pr-phosphor[data-icon=caretRight] { width:24px; height:24px; font-size:24px; color:var(--text-dim); }
.plugin-public-pr details[open]>summary>.pr-phosphor[data-icon=caretRight] { transform:rotate(90deg); }
.plugin-public-pr :is(.pr-list-section,.pr-recent-runs,.pr-subpanel)>summary { padding:12px 16px; margin:-16px; background:var(--panel-hi); border-radius:12px; }
.plugin-public-pr :is(.pr-list-section,.pr-recent-runs,.pr-subpanel)[open]>summary { margin-bottom:0; border-end-start-radius:0; border-end-end-radius:0; border-bottom:1px solid var(--line); }
.plugin-public-pr :is(.pr-list-section,.pr-recent-runs,.pr-subpanel)>summary:hover { background:var(--panel-2); }
.plugin-public-pr .pr-subpanel>summary { background:var(--panel); border-start-start-radius:6px; border-start-end-radius:6px; }
.plugin-public-pr .pr-subpanel:not([open])>summary { border-end-start-radius:6px; border-end-end-radius:6px; }
.plugin-public-pr .pr-recent-runs>summary { font-size:17px; font-weight:600; color:var(--text-dim); }
.plugin-public-pr .pr-recent-runs .pr-list-count { margin-left:8px; }
.plugin-public-pr .pr-list-more>summary { font-size:14px; color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-panel { border:1px solid var(--line-strong,var(--line)); border-radius:10px; background:var(--panel); margin-top:16px; padding:16px; display:flex; flex-direction:column; gap:12px; }
.plugin-public-pr .pr-subpanel { display:block; border:1px solid var(--line); border-radius:6px; background:var(--panel-2); padding:16px; }
.plugin-public-pr .pr-subpanel>summary { color:var(--text); font-size:16px; font-weight:600; }
.plugin-public-pr .pr-subpanel>summary>:is(span,h4) { display:inline-flex; align-items:center; gap:6px; vertical-align:middle; }
.plugin-public-pr :is(.pr-summary-body,.pr-agent-body,.pr-diff-body) { display:flex; flex-direction:column; gap:12px; margin-top:12px; }
.plugin-public-pr .pr-panel-head { display:flex; flex-direction:column; gap:8px; }
.plugin-public-pr .pr-panel-title { font-size:20px; font-weight:650; line-height:1.4; overflow-wrap:anywhere; }
.plugin-public-pr .pr-panel-byline { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px 12px; font-size:13px; color:var(--text-dim); overflow-wrap:anywhere; }
.plugin-public-pr .pr-panel h4 { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font:600 15px/1.4 var(--sans,sans-serif); margin:0; }
.plugin-public-pr .pr-evidence { display:grid; gap:12px; }
.plugin-public-pr .pr-evidence-row { display:flex; align-items:baseline; flex-wrap:wrap; gap:8px 20px; }
.plugin-public-pr .pr-evidence-row h4 { flex:0 0 96px; }
.plugin-public-pr .pr-evidence-row ul { display:flex; flex-wrap:wrap; flex:1 1 300px; list-style:none; padding:0; gap:6px 16px; }
.plugin-public-pr .pr-evidence-count { display:inline-flex; align-items:center; gap:5px; font-size:13px; }
.plugin-public-pr .pr-evidence-count strong { font-weight:600; font-variant-numeric:tabular-nums; }
.plugin-public-pr .pr-evidence-count[data-tone=good] strong { color:var(--good-text,var(--good)); }
.plugin-public-pr .pr-evidence-count[data-tone=bad] strong { color:var(--bad-text,var(--bad)); }
.plugin-public-pr .pr-evidence-count[data-tone=queued] strong { color:var(--queued-text,var(--queued)); }
.plugin-public-pr .pr-evidence-count[data-tone=review] strong { color:var(--review-text,var(--review)); }
.plugin-public-pr .pr-evidence-quality { font-size:12px; font-weight:400; color:var(--text-dim); }
.plugin-public-pr .pr-stat-preview { display:block; position:relative; }
.plugin-public-pr .pr-stat-preview>summary { display:inline-flex; gap:5px; padding:2px 0; min-height:24px; font-size:13px; text-decoration:underline dotted; text-underline-offset:4px; border-radius:3px; }
.plugin-public-pr .pr-stat-popup { position:absolute; inset-block-start:100%; inset-inline-start:0; z-index:10; box-sizing:border-box; width:340px; max-width:calc(100vw - 48px); max-height:min(440px,65vh); overflow:auto; padding:14px; background:var(--panel-hi); color:var(--text); border:1px solid var(--line-strong); border-radius:6px; font-size:13px; }
.plugin-public-pr .pr-stat-preview[data-align=end]>.pr-stat-popup { inset-inline-start:auto; inset-inline-end:0; }
.plugin-public-pr .pr-stat-preview .pr-stat-popup ul { display:grid; flex:none; gap:8px; margin:10px 0 0; padding:0; list-style:none; }
.plugin-public-pr .pr-stat-popup li { overflow-wrap:anywhere; }
.plugin-public-pr .pr-evidence-more { display:block; margin-top:10px; }
.plugin-public-pr .pr-evidence-more>summary { min-height:28px; font-size:13px; color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-evidence-note { margin-top:10px; color:var(--text-dim); font-size:13px; }
.plugin-public-pr .pr-discussion { display:block; border-top:1px solid var(--line); padding-top:4px; font-size:14px; }
.plugin-public-pr .pr-discussion>summary>span { display:inline-flex; align-items:center; flex-wrap:wrap; gap:6px; }
.plugin-public-pr .pr-discussion-count { font-weight:400; color:var(--text-dim); font-variant-numeric:tabular-nums; }
.plugin-public-pr .pr-discussion-body { display:grid; gap:12px; margin-top:10px; }
.plugin-public-pr .pr-discussion-entry { min-width:0; padding:12px; border:1px solid var(--line); border-radius:6px; background:var(--panel); }
.plugin-public-pr .pr-discussion-byline { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px 12px; font-size:13px; }
.plugin-public-pr .pr-discussion-byline time { color:var(--text-dim); }
.plugin-public-pr .pr-discussion-text { margin-top:8px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
.plugin-public-pr .pr-provenance { font-size:13px; color:var(--text-dim); border-top:1px solid var(--line); padding-top:8px; }
.plugin-public-pr .pr-provenance summary { min-height:32px; padding:4px 0; width:fit-content; }
.plugin-public-pr .pr-panel-context { display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:8px; overflow-wrap:anywhere; }
.plugin-public-pr .pr-panel-context>span { display:inline-flex; align-items:center; flex-wrap:wrap; gap:5px; min-width:0; }
.plugin-public-pr .pr-agent-section { background:var(--panel-hi); }
.plugin-public-pr .pr-agent-section>summary .pr-phosphor { color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-agent-section .tuning { max-width:720px; }
.plugin-public-pr .pr-agent-section :is(label,input,select,textarea) { font-size:14px; }
.plugin-public-pr .pr-review-agent { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:600; }
.plugin-public-pr .pr-review-agent:hover:not(:disabled) { background:var(--accent); color:var(--on-accent); border-color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-agent-section .pr-review-agent>.pr-phosphor { color:inherit; }
.plugin-public-pr .pr-agent-extras { display:flex; align-items:center; flex-wrap:wrap; gap:8px 16px; font-size:14px; }
.plugin-public-pr .pr-agent-extras:empty { display:none; }
.plugin-public-pr .pr-slack-review { display:inline-flex; align-items:center; gap:6px; }
.plugin-public-pr .pr-manual-review { display:block; font-size:14px; }
.plugin-public-pr .pr-manual-review>summary { color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-manual-review>summary>span { display:inline-flex; align-items:center; gap:6px; vertical-align:middle; }
.plugin-public-pr .pr-manual-body { display:flex; flex-direction:column; gap:12px; margin-top:12px; }
.plugin-public-pr :is(.pr-review-body,.pr-rerun-feedback,.pr-review-guidance) { width:100%; min-height:80px; }
.plugin-public-pr .pr-review-actions { display:flex; flex-wrap:wrap; gap:8px; }
.plugin-public-pr .tuning { display:flex; flex-wrap:wrap; gap:12px; }
.plugin-public-pr .tuning label { flex:1; min-width:160px; }
.plugin-public-pr .pr-review-error { color:var(--text); font-size:14px; display:flex; align-items:flex-start; gap:8px; }
.plugin-public-pr .pr-review-error>.pr-phosphor { color:var(--bad); }
.plugin-public-pr .pr-pending { overflow-wrap:anywhere; }
.plugin-public-pr [data-storage-error]:empty { display:none; }
.plugin-public-pr .pr-diff { display:flex; flex-direction:column; gap:8px; }
.plugin-public-pr .diff-file { min-width:0; border:1px solid var(--line-faint); border-radius:6px; background:var(--panel-2); }
.plugin-public-pr .diff-file-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 12px; font-size:14px; }
.plugin-public-pr .diff-file-name { min-width:0; overflow-wrap:anywhere; }
.plugin-public-pr .diff-file-stat { display:inline-flex; gap:6px; white-space:nowrap; }
.plugin-public-pr .diff-file-stat strong { font-weight:700; }
.plugin-public-pr .diff-file-added { color:var(--good); }
.plugin-public-pr .diff-file-deleted { color:var(--bad); }
.plugin-public-pr .diff-file>.empty-note { padding:8px 12px; }
.plugin-public-pr .diff-patch { margin:0; padding:12px; overflow-x:auto; font:14px/1.45 var(--mono,monospace); border-top:1px solid var(--line-faint); }
.plugin-public-pr .pr-phosphor { display:inline-block; width:18px; height:18px; flex-shrink:0; font-family:"Helmsman Phosphor Regular"; font-size:18px; font-weight:400; font-style:normal; font-synthesis:none; line-height:1; letter-spacing:normal; text-transform:none; vertical-align:-3px; }
.plugin-public-pr .pr-phosphor::before { content:attr(data-glyph); }
.plugin-public-pr :is(button.pr-lookup-go,.pr-review-actions button) { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.plugin-public-pr .pr-lookup-panel { background:var(--panel-hi); border-color:var(--line-strong,var(--line)); }
.plugin-public-pr .pr-lookup-heading h3>.pr-phosphor { color:var(--accent-text,var(--accent)); }
.plugin-public-pr .pr-lookup-go { background:var(--accent); border-color:var(--accent); color:var(--on-accent); font-weight:600; }
.plugin-public-pr .pr-lookup-go:hover:not(:disabled) { background:var(--accent); border-color:var(--accent-text,var(--accent)); color:var(--on-accent); }
.plugin-public-pr .pr-inbox h3 { padding:0; border:0; }
.plugin-public-pr .pr-review-requests h3>.pr-phosphor { color:var(--review); }
.plugin-public-pr .pr-authored h3>.pr-phosphor { color:var(--text-dim); }
.plugin-public-pr .pr-recent-runs { background:var(--bg,var(--panel)); border-color:var(--line-faint); }
.plugin-public-pr .pr-history-heading { display:inline-flex; align-items:center; gap:8px; }
.plugin-public-pr .pr-recent-runs[open]>summary { margin-bottom:8px; }
.plugin-public-pr .pr-recent-runs .pr-list-title { font-size:16px; font-weight:500; }
.plugin-public-pr [data-tone=good]>.pr-phosphor,.plugin-public-pr .pr-approve>.pr-phosphor { color:var(--good); }
.plugin-public-pr [data-tone=bad]>.pr-phosphor,.plugin-public-pr .pr-request-changes>.pr-phosphor { color:var(--bad); }
.plugin-public-pr [data-tone=review]>.pr-phosphor,.plugin-public-pr :is(.pr-review-agent,.pr-comment)>.pr-phosphor { color:var(--review); }
.plugin-public-pr [data-tone=queued]>.pr-phosphor { color:var(--queued); }
.plugin-public-pr [data-tone=neutral]>.pr-phosphor { color:var(--text-dim); }
.plugin-public-pr .pr-list-stat { display:inline-flex; align-items:center; gap:5px; }
.plugin-public-pr .pr-list-notice>.pr-phosphor { margin-right:6px; }
@media(max-width:700px) { .plugin-public-pr .pr-inbox { grid-template-columns:1fr; } .plugin-public-pr .pr-lookup-form { flex-wrap:wrap; } .plugin-public-pr .pr-lookup-form label { flex-basis:100%; } .plugin-public-pr .pr-evidence-row { gap:6px; } .plugin-public-pr .pr-evidence-row h4 { flex-basis:100%; } }
@media(any-pointer:coarse) { .plugin-public-pr :is(button,input,select,summary),.plugin-public-pr .pr-provenance summary,.plugin-public-pr .pr-stat-preview>summary,.plugin-public-pr .pr-evidence-more>summary { min-height:44px; } }
`;

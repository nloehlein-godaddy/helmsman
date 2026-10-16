export const styles = `
.agents-overview { --overview-accent:var(--accent-text,var(--accent)); display:grid; gap:28px; max-width:1240px; color:var(--text); }
.agents-overview h1,.agents-overview h2,.agents-overview h3,.agents-overview p { margin:0; }
.agents-overview h1 { font-size:28px; line-height:1.2; }
.agents-overview h2 { font-size:19px; line-height:1.35; }
.agents-overview h3 { font-size:16px; line-height:1.4; }
.agents-overview p { line-height:1.55; }
.agents-overview .overview-intro { display:grid; gap:10px; }
.agents-overview .overview-intro p { max-width:72ch; color:var(--text-dim); }
.agents-overview .overview-layers { list-style:none; padding:0; margin:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.agents-overview .overview-layers li { display:grid; grid-template-columns:32px 170px minmax(0,1fr); align-items:center; gap:16px; padding:18px 22px; }
.agents-overview .overview-layers li+li { border-top:1px solid var(--line); }
.agents-overview .overview-layers li:nth-child(2) { background:var(--panel-hi); }
.agents-overview .overview-layers li:first-child { background:var(--panel); }
.agents-overview .overview-layers li:last-child { background:var(--panel-2); }
.agents-overview .overview-layers strong { font-size:16px; }
.agents-overview .overview-layers p { color:var(--text-dim); }
.agents-overview svg { width:22px; height:22px; flex-shrink:0; color:var(--overview-accent); }
.agents-overview .overview-workflows { display:grid; gap:18px; }
.agents-overview .overview-flow-picker { display:flex; flex-wrap:wrap; gap:8px; }
.agents-overview button { cursor:pointer; }
.agents-overview .overview-flow-picker button { min-height:44px; padding:9px 16px; }
.agents-overview .overview-flow-picker button[aria-pressed=true] { color:var(--on-accent); background:var(--accent); border-color:var(--accent); }
.agents-overview :is(button,a):focus-visible { outline:2px solid var(--overview-accent); outline-offset:4px; }
.agents-overview .overview-flow-description { color:var(--text-dim); max-width:75ch; }
.agents-overview .overview-map { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,0.8fr); align-items:start; gap:24px; }
.agents-overview .overview-route { display:grid; gap:18px; }
.agents-overview .overview-stages { list-style:none; margin:0; padding:0; display:grid; gap:0; }
.agents-overview .overview-stages > li { position:relative; padding-bottom:22px; }
.agents-overview .overview-stages > li:last-child { padding-bottom:0; }
.agents-overview .overview-stages > li:not(:last-child)::after { content:''; position:absolute; height:22px; width:1px; background:var(--line-strong); left:27px; bottom:0; }
.agents-overview .overview-condition { padding:0 0 8px 16px; font-size:12px; color:var(--text-dim); }
.agents-overview .overview-role { display:flex; align-items:center; gap:16px; width:100%; padding:16px; text-align:left; background:var(--panel); border:1px solid var(--line); border-radius:8px; color:var(--text); }
.agents-overview .overview-role[aria-pressed=true] { border-color:var(--overview-accent); background:var(--panel-hi); }
.agents-overview .overview-role:hover { background:var(--panel-hi); }
.agents-overview .overview-role span { display:grid; gap:4px; min-width:0; }
.agents-overview .overview-role strong { font-size:15px; line-height:1.4; }
.agents-overview .overview-role small { color:var(--text-dim); font-size:13px; line-height:1.45; }
.agents-overview .overview-role .overview-chevron { width:16px; height:16px; margin-left:auto; color:var(--text-dim); }
.agents-overview .overview-outcome { display:flex; align-items:center; gap:10px; padding:14px 16px; border-block:1px solid var(--line); color:var(--text); font-size:14px; }
.agents-overview .overview-outcome svg { color:var(--good); }
.agents-overview .overview-loop { display:flex; align-items:flex-start; gap:10px; color:var(--text-dim); font-size:13px; }
.agents-overview .overview-loop svg { width:18px; height:18px; margin-top:2px; }
.agents-overview .overview-role-detail { background:var(--panel-2); padding:22px; border:1px solid var(--line); border-radius:12px; display:grid; gap:16px; }
.agents-overview .overview-role-detail>p { font-size:14px; color:var(--text-dim); }
.agents-overview .overview-role-detail dl { display:grid; gap:16px; margin:0; }
.agents-overview dt { font-weight:600; font-size:13px; margin-bottom:4px; }
.agents-overview dd { margin:0; color:var(--text-dim); font-size:14px; line-height:1.55; }
.agents-overview .overview-specialists { display:grid; gap:10px; padding:16px 0 0 27px; border-left:1px solid var(--line-strong); margin-left:27px; }
.agents-overview .overview-specialists h3 { font-size:14px; }
.agents-overview .overview-specialists ul { display:flex; flex-wrap:wrap; list-style:none; padding:0; margin:0; gap:6px 16px; font-size:13px; color:var(--text-dim); }
.agents-overview .overview-specialists p { color:var(--text-dim); font-size:13px; }
.agents-overview .overview-support { display:grid; gap:16px; padding-top:24px; border-top:1px solid var(--line); }
.agents-overview .overview-helper { display:grid; grid-template-columns:24px 190px minmax(0,1fr); align-items:start; gap:14px; }
.agents-overview .overview-helper p { color:var(--text-dim); font-size:14px; }
.agents-overview .overview-settings { padding:20px 22px; background:var(--panel); border:1px solid var(--line); border-radius:12px; display:grid; gap:12px; }
.agents-overview .overview-settings p { color:var(--text-dim); font-size:14px; max-width:85ch; }
.agents-overview .overview-links { display:flex; flex-wrap:wrap; gap:12px 24px; }
.agents-overview a { color:var(--overview-accent); text-underline-offset:3px; }
@media(max-width:800px) { .agents-overview .overview-map { grid-template-columns:minmax(0,1fr); } }
@media(max-width:560px) {
.agents-overview { gap:24px; }
.agents-overview h1 { font-size:24px; }
.agents-overview .overview-layers li { grid-template-columns:24px minmax(0,1fr); gap:8px 12px; padding:16px; }
.agents-overview .overview-layers p { grid-column:2; font-size:14px; }
.agents-overview .overview-helper { grid-template-columns:24px minmax(0,1fr); gap:8px 12px; }
.agents-overview .overview-helper p { grid-column:2; }
.agents-overview .overview-flow-picker button { flex:1; padding-inline:8px; font-size:13px; }
.agents-overview .overview-role-detail,.agents-overview .overview-settings { padding:18px; }
}
`;

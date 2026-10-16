export const styles = `
.agent-prompts { font:16px/1.5 var(--sans,sans-serif); color:var(--text); min-width:0; padding:20px; }
.agent-prompts [hidden] { display:none; }
.agent-prompts h2 { margin:0 0 8px; font-size:20px; line-height:1.3; }
.agent-prompts h3 { margin:0 0 4px; font-size:17px; line-height:1.4; }
.agent-prompts p { margin:0; max-width:75ch; overflow-wrap:anywhere; }
.agent-prompts .prompt-intro { display:flex; flex-direction:column; gap:6px; margin-bottom:20px; }
.agent-prompts .prompt-intro p,.agent-prompts .prompt-note,.agent-prompts .prompt-provider { color:var(--text-dim); font-size:14px; }
.agent-prompts form { display:flex; flex-direction:column; gap:12px; }
.agent-prompts .prompt-picker { display:flex; align-items:flex-end; flex-wrap:wrap; gap:12px; padding:16px; background:var(--panel-hi); border:1px solid var(--line); border-radius:6px; }
.agent-prompts .prompt-picker label { flex:1 1 260px; max-width:440px; }
.agent-prompts .prompt-source { font-size:13px; padding:6px 0; color:var(--text-dim); }
.agent-prompts label { display:flex; flex-direction:column; gap:6px; font-weight:600; }
.agent-prompts .prompt-context { padding:4px 0; }
.agent-prompts .prompt-context p { font-size:14px; }
.agent-prompts .prompt-provider { margin-top:4px; }
.agent-prompts :is(button,select,textarea) { font:inherit; border-radius:6px; min-height:36px; max-width:100%; box-sizing:border-box; }
.agent-prompts :is(select,textarea) { padding:8px 12px; background:var(--control-bg,var(--panel)); color:var(--text); border:1px solid var(--control-border,var(--line-strong)); font-weight:400; }
.agent-prompts textarea { resize:vertical; width:100%; min-height:340px; font:14px/1.55 var(--mono,monospace); tab-size:2; }
.agent-prompts .prompt-tools { display:flex; flex-wrap:wrap; gap:8px; }
.agent-prompts .prompt-tools:has(>button[hidden]:only-child) { display:none; }
.agent-prompts button { padding:7px 12px; color:var(--text); background:var(--panel-hi); border:1px solid var(--line-strong); cursor:pointer; }
.agent-prompts button:hover:not(:disabled) { background:var(--panel-2); border-color:var(--accent-text,var(--accent)); }
.agent-prompts button.primary-action { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:600; }
.agent-prompts button.primary-action:hover:not(:disabled) { background:var(--accent); color:var(--on-accent); border-color:var(--accent-text,var(--accent)); }
.agent-prompts :is(button,select,textarea):disabled { opacity:.5; cursor:default; }
.agent-prompts :is(button,select,textarea,summary,pre):focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.agent-prompts .prompt-default { border-block:1px solid var(--line); padding:8px 0; }
.agent-prompts summary { cursor:pointer; min-height:36px; padding:6px 0; font-size:14px; color:var(--accent-text,var(--accent)); }
.agent-prompts pre { margin:12px 0 0; padding:12px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:360px; overflow:auto; color:var(--text); background:var(--panel-2); font:13px/1.55 var(--mono,monospace); border-radius:6px; }
.agent-prompts [role=alert] { color:var(--bad-text,var(--bad)); font-size:14px; }
.agent-prompts [role=alert]:empty,.agent-prompts [role=status]:empty { display:none; }
.agent-prompts [role=status] { font-size:14px; }
@media(max-width:600px) { .agent-prompts { padding:12px; } .agent-prompts textarea { min-height:280px; } .agent-prompts .prompt-picker { padding:12px; } }
@media(any-pointer:coarse) { .agent-prompts :is(button,select,summary) { min-height:44px; } }
`;

export const styles = `
.local-git-panel { min-width: 0; }
.local-git-panel .panel-head { flex-wrap: wrap; gap:12px; }
.local-git-actions { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
:is(.local-git-refresh, .local-git-release, .local-git-confirm-release) {
  border: 1px solid var(--line); border-radius: 6px; background: var(--panel);
  color: var(--accent); font: 16px var(--sans, sans-serif); padding: 5px 9px; cursor: pointer;
}
:is(.local-git-refresh, .local-git-release, .local-git-confirm-release):hover:not(:disabled) { border-color: var(--accent); }
:is(.local-git-refresh, .local-git-release, .local-git-confirm-release):disabled { opacity: 0.5; cursor: default; }
:is(.local-git-refresh, .local-git-release, .local-git-confirm-release):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.local-git-checkout { display: grid; gap: 6px; padding: 14px; border-bottom: 1px solid var(--line-faint); }
.local-git-label { color: var(--text-dim); font-size: 14px; }
.local-git-path { font-size: 14px; overflow-wrap: anywhere; }
.local-git-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.local-git-group { min-width: 0; }
.local-git-group + .local-git-group { border-left: 1px solid var(--line-faint); }
.local-git-group h3 { display: flex; gap: 12px; margin: 0; padding: 12px 14px; font: 16px var(--sans, sans-serif); border-bottom: 1px solid var(--line-faint); }
.local-git-count { color: var(--text-dim); margin-left: auto; }
.local-git-list { list-style: none; padding: 0; margin: 0; max-height: 360px; overflow-y: auto; }
.local-git-item { padding: 12px 14px; border-bottom: 1px solid var(--line-faint); }
.local-git-item:last-child { border-bottom: none; }
.local-git-item-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.local-git-name { font-size: 14px; overflow-wrap: anywhere; min-width: 0; }
.local-git-commit { color: var(--text-dim); font-size: 14px; margin-left: auto; }
.local-git-upstream, .local-git-item > .local-git-path { color: var(--text-dim); margin-top: 6px; overflow-wrap: anywhere; font-size: 14px; }
.local-git-error { color: var(--bad); padding: 14px; overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .local-git-columns { grid-template-columns: minmax(0, 1fr); }
.local-git-group + .local-git-group { border-left: none; border-top: 1px solid var(--line-faint); }
.local-git-list { max-height: 300px; }

}
.local-git-delete {
  border: 1px solid var(--line); border-radius: 6px; background: var(--panel);
  color: var(--bad); font: 16px var(--sans, sans-serif); padding: 5px 9px; cursor: pointer;
}
.local-git-delete:hover:not(:disabled) { border-color: var(--bad); }
.local-git-delete:disabled { opacity: 0.5; cursor: default; }
.local-git-delete:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.local-git-item-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.local-git-blocked { color: var(--text-dim); font-size: 14px; overflow-wrap: anywhere; flex: 1 1 120px; }
.local-git-hint { color: var(--text-dim); font-size: 14px; line-height: 1.6; padding: 12px 14px; margin: 0; border-bottom: 1px solid var(--line-faint); }
.local-git-gone { color: var(--bad); }
.local-git-confirmation { padding: 14px; border-bottom: 1px solid var(--line); background: var(--panel); font-size: 14px; overflow-wrap: anywhere; }
.local-git-confirmation p { color: var(--text-dim); line-height: 1.6; }
.local-git-force-label { display: flex; align-items: center; gap: 8px; color: var(--bad); }
.local-git-cleanup-list { list-style: none; margin: 12px 0; padding: 0; max-height: 240px; overflow-y: auto; }
.local-git-cleanup-list li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line-faint); }
.local-git-cleanup-reason { flex-basis: 100%; color: var(--text-dim); font-size: 14px; overflow-wrap: anywhere; }
.local-git-cleanup-skipped summary { color: var(--text-dim); cursor: pointer; width: fit-content; }
.local-git-cleanup-skipped summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.local-git-cleanup-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line-faint); font-size: 14px; }
.local-git-cleanup .local-git-cleanup-warning { color: var(--bad); }
.plugin-local-git .local-git-recovery { padding: 1rem; overflow-wrap:anywhere; }
.plugin-local-git .local-git-recovery article { border-bottom:1px solid var(--line);padding:.75rem 0; }
.plugin-local-git .local-git-recovery button { margin-right:.5rem; }
.plugin-local-git { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-local-git :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-local-git h1 { font-size: 26px; }
.plugin-local-git h2 { font-size: 20px; }
.plugin-local-git h3 { font-size: 18px; }
.plugin-local-git :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-local-git button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-local-git button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-local-git button:disabled { cursor: default; opacity: .5; }
.plugin-local-git :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-local-git :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-local-git :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-local-git small { font-size: 14px; }
.plugin-local-git p { max-width: 75ch; }
.plugin-local-git :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-local-git :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-local-git button { transition: none; }
 }
.plugin-local-git .local-git-group h3 { font: 600 18px/1.4 var(--sans,sans-serif); padding: 12px 16px; }
.plugin-local-git :is(.local-git-name,.local-git-path,.local-git-commit) { font-family: var(--mono,monospace); }
.plugin-local-git .local-git-refresh { color: var(--text); }
`;

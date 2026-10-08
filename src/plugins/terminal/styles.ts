export const styles = `
.plugin-terminal { min-width:0; padding:1rem; }
.plugin-terminal * { box-sizing:border-box; }
.plugin-terminal h2,.plugin-terminal h3 { margin:.25rem 0 .75rem; }
.plugin-terminal .terminal-toolbar,.plugin-terminal .terminal-actions,.plugin-terminal .terminal-keypad,.plugin-terminal .terminal-capture { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin-block:.5rem; }
.plugin-terminal .terminal-columns { display:grid; grid-template-columns:minmax(180px,1fr) minmax(0,2fr); gap:1rem; }
.plugin-terminal .terminal-column { min-width:0; border:1px solid var(--line-faint); border-radius:6px; padding:.75rem; }
.plugin-terminal .terminal-column-head { display:flex; justify-content:space-between; gap:.5rem; align-items:center; }
.plugin-terminal .terminal-tabs { display:grid; gap:.4rem; }
.plugin-terminal .terminal-tab { display:grid; gap:.3rem; text-align:left; width:100%; padding:.6rem; }
.plugin-terminal .terminal-tab[aria-pressed=true] { border-color:var(--accent); color:var(--accent-text,var(--accent)); }
.plugin-terminal .terminal-tab small { color: var(--text-dim); overflow-wrap:anywhere; }
.plugin-terminal button,.plugin-terminal select,.plugin-terminal input { color:var(--text); background:var(--rail); border:1px solid var(--line-strong); border-radius:6px; padding:.4rem .6rem; font:inherit; max-width:100%; }
.plugin-terminal :is(input,select){background-color:var(--control-bg,var(--rail));border-color:var(--control-border,var(--line-strong))}
.plugin-terminal button { cursor:pointer; }
.plugin-terminal button:disabled { opacity:.55; cursor:default; }
.plugin-terminal button:focus-visible,.plugin-terminal input:focus-visible,.plugin-terminal select:focus-visible,.plugin-terminal pre:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.plugin-terminal .terminal-screen { white-space:pre-wrap; overflow-wrap:anywhere; overflow:auto; height:24rem; padding:.75rem; margin:.5rem 0; border:1px solid var(--line-faint); background:var(--bg); font:14px/1.45 var(--mono); }
.plugin-terminal .terminal-screen.is-capturing { outline:2px solid var(--accent); outline-offset:-2px; }
.plugin-terminal .terminal-send { display:flex; align-items:end; gap:.5rem; margin:.75rem 0; }
.plugin-terminal .terminal-send label { display:grid; gap:.35rem; flex:1; min-width:0; }
.plugin-terminal .terminal-send input { width:100%; min-width:0; }
.plugin-terminal .terminal-error { color:var(--bad); overflow-wrap:anywhere; }
.plugin-terminal .terminal-note,.plugin-terminal .terminal-capture-help { color:var(--text-dim); font-size:.85rem; }
.plugin-terminal article { margin-top:.75rem; padding-top:.75rem; border-top:1px solid var(--line-faint); overflow-wrap:anywhere; }
.plugin-terminal [hidden] { display:none !important; }
@media(max-width:700px) { .plugin-terminal .terminal-columns { grid-template-columns:minmax(0,1fr); }
.plugin-terminal { padding:.5rem; }
.plugin-terminal .terminal-screen { height:18rem; }
 }
.plugin-terminal { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-terminal :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-terminal h1 { font-size: 26px; }
.plugin-terminal h2 { font-size: 20px; }
.plugin-terminal h3 { font-size: 18px; }
.plugin-terminal :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-terminal button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-terminal button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-terminal button:disabled { cursor: default; opacity: .5; }
.plugin-terminal :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-terminal :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-terminal :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-terminal small { font-size: 14px; }
.plugin-terminal p { max-width: 75ch; }
.plugin-terminal :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-terminal :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-terminal button { transition: none; }
 }
.plugin-terminal .terminal-column { border-radius: 12px; padding: 16px; }
.plugin-terminal .terminal-tab[aria-pressed=true] { background: color-mix(in srgb,var(--accent) 10%,var(--face)); border-color: var(--accent); color: var(--text); }
.plugin-terminal .terminal-screen { border-radius: 6px; }
`;

export const styles = `
.plugin-terminal { min-width:0; padding:1rem; }
.plugin-terminal * { box-sizing:border-box; }
.plugin-terminal h2,.plugin-terminal h3 { margin:.25rem 0 .75rem; }
.plugin-terminal .terminal-toolbar,.plugin-terminal .terminal-actions,.plugin-terminal .terminal-keypad,.plugin-terminal .terminal-capture { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin-block:.5rem; }
.plugin-terminal .terminal-columns { display:grid; grid-template-columns:minmax(180px,1fr) minmax(0,2fr); gap:1rem; }
.plugin-terminal .terminal-column { min-width:0; border:1px solid var(--line-faint); border-radius:var(--radius); padding:.75rem; }
.plugin-terminal .terminal-column-head { display:flex; justify-content:space-between; gap:.5rem; align-items:center; }
.plugin-terminal .terminal-tabs { display:grid; gap:.4rem; }
.plugin-terminal .terminal-tab { display:grid; gap:.3rem; text-align:left; width:100%; padding:.6rem; }
.plugin-terminal .terminal-tab[aria-pressed=true] { border-color:var(--accent); color:var(--accent); }
.plugin-terminal .terminal-tab small { color:var(--text-faint); overflow-wrap:anywhere; }
.plugin-terminal button,.plugin-terminal select,.plugin-terminal input { color:var(--text); background:var(--rail); border:1px solid var(--line-strong); border-radius:var(--radius); padding:.4rem .6rem; font:inherit; max-width:100%; }
.plugin-terminal button { cursor:pointer; } .plugin-terminal button:disabled { opacity:.55; cursor:default; }
.plugin-terminal button:focus-visible,.plugin-terminal input:focus-visible,.plugin-terminal select:focus-visible,.plugin-terminal pre:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.plugin-terminal .terminal-screen { white-space:pre-wrap; overflow-wrap:anywhere; overflow:auto; height:24rem; padding:.75rem; margin:.5rem 0; border:1px solid var(--line-faint); background:var(--bg); font:12px/1.45 var(--mono); }
.plugin-terminal .terminal-screen.is-capturing { outline:2px solid var(--accent); outline-offset:-2px; }
.plugin-terminal .terminal-send { display:flex; align-items:end; gap:.5rem; margin:.75rem 0; }
.plugin-terminal .terminal-send label { display:grid; gap:.35rem; flex:1; min-width:0; }
.plugin-terminal .terminal-send input { width:100%; min-width:0; }
.plugin-terminal .terminal-error { color:var(--bad); overflow-wrap:anywhere; }
.plugin-terminal .terminal-note,.plugin-terminal .terminal-capture-help { color:var(--text-dim); font-size:.85rem; }
.plugin-terminal article { margin-top:.75rem; padding-top:.75rem; border-top:1px solid var(--line-faint); overflow-wrap:anywhere; }
.plugin-terminal [hidden] { display:none !important; }
@media(max-width:700px) { .plugin-terminal .terminal-columns { grid-template-columns:minmax(0,1fr); } .plugin-terminal { padding:.5rem; } .plugin-terminal .terminal-screen { height:18rem; } }
`;

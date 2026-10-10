const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
export const styles = `
@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-terminal{min-width:0;color:var(--text);font:14px/1.5 var(--sans,sans-serif)}
.plugin-terminal *{box-sizing:border-box}
.plugin-terminal :is(h1,h2,h3,p){margin:0}
.plugin-terminal :is(h1,h2,h3){font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance}
.plugin-terminal h1{font-size:26px}.plugin-terminal h2{font-size:20px}.plugin-terminal h3{font-size:16px}
.plugin-terminal :is(button,input,select){font:14px/1.4 var(--sans,sans-serif);color:var(--text);background:var(--panel-hi,var(--face-hi));border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;min-height:32px;max-width:100%}
.plugin-terminal :is(input,select){color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong));caret-color:var(--input-text,var(--text))}
.plugin-terminal button{cursor:pointer;transition:background-color 160ms ease-out,border-color 160ms ease-out}
.plugin-terminal button:hover:not(:disabled){background:var(--panel-2,var(--face-hi));border-color:var(--line-strong)}
.plugin-terminal button:disabled{opacity:.5;cursor:default}
.plugin-terminal :is(button,input,select,pre,summary,a,section[tabindex]):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:3px}
.plugin-terminal small{font-size:12px;color:var(--text-dim);overflow-wrap:anywhere}
.plugin-terminal p{overflow-wrap:anywhere;max-width:75ch}
.plugin-terminal [hidden]{display:none!important}
.plugin-terminal.terminal-panel{display:grid;gap:16px;padding:0}
.terminal-panel .terminal-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2,var(--face-hi))}
.terminal-panel .terminal-connection{display:inline-flex;align-items:center;gap:8px;flex:1;min-width:150px;color:var(--text)}
.terminal-panel .terminal-connection .terminal-phosphor{color:var(--text-dim)}
.terminal-panel .terminal-connection[data-connected=true] .terminal-phosphor{color:var(--good)}
.terminal-panel .terminal-status{color:var(--text-dim);font-size:12px}
.terminal-panel .terminal-columns{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:16px;align-items:start}
.terminal-panel .terminal-column{min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--panel,var(--face));overflow:hidden}
.terminal-panel .terminal-column-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:var(--panel-hi,var(--face-hi));border-bottom:1px solid var(--line)}
.terminal-panel .terminal-column-head h3{min-width:0;overflow-wrap:anywhere}
.terminal-panel .terminal-column-head button{font-size:12px;color:var(--text-dim);background:transparent;border-color:transparent;padding:4px 6px;min-height:28px}
.terminal-panel .terminal-tabs{display:grid;gap:0;padding:8px}
.terminal-panel .terminal-tab{display:grid;gap:6px;text-align:left;width:100%;padding:12px;border:1px solid transparent;background:transparent}
.terminal-panel .terminal-tab[aria-pressed=true]{background:var(--panel-2,var(--face-hi));border-color:var(--line-strong);color:var(--text)}
.terminal-panel .terminal-tab-title{display:flex;gap:8px;align-items:center;font-weight:600;overflow-wrap:anywhere;min-width:0}
.terminal-panel .terminal-tab[aria-pressed=true] .terminal-tab-title .terminal-phosphor{color:var(--accent-text,var(--accent))}
.terminal-panel .terminal-tab-prompt{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere;padding-left:24px;font-size:13px;line-height:1.5;color:var(--text)}
.terminal-panel .terminal-tab-prompt.is-empty{color:var(--text-dim);font-size:12px}
.terminal-panel .terminal-tab small{padding-left:24px}
.terminal-panel .terminal-screen-column>div:last-child{padding:16px;display:grid;gap:12px}
.terminal-panel :is(.terminal-capture,.terminal-keypad,.terminal-actions){display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.terminal-panel .terminal-capture button{font-size:12px}
.terminal-panel .terminal-screen{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;min-height:320px;height:clamp(320px,48vh,560px);padding:16px;margin:0;border:1px solid var(--line);border-radius:6px;background:var(--control-bg,var(--bg));color:var(--input-text,var(--text));font:13px/1.5 var(--mono,monospace);scrollbar-color:var(--line-strong) var(--control-bg,var(--bg))}
.terminal-panel .terminal-screen.is-capturing{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.terminal-panel .terminal-send{display:flex;align-items:flex-end;gap:8px;margin:0}
.terminal-panel .terminal-send label{display:grid;gap:6px;flex:1;min-width:0;font-size:12px;color:var(--text-dim)}
.terminal-panel .terminal-send input{width:100%;min-width:0}
.terminal-panel .terminal-send button{color:var(--on-accent);background:var(--accent);border-color:var(--accent);font-weight:600}
.terminal-panel .terminal-send button:hover:not(:disabled){color:var(--on-accent);background:var(--accent-bright,var(--accent));border-color:var(--accent-bright,var(--accent))}
.terminal-panel .terminal-keypad button{font-size:12px;min-width:36px}
.terminal-panel :is(.terminal-note,.terminal-capture-help){color:var(--text-dim);font-size:12px}
.terminal-panel .terminal-error{color:var(--text);border:1px solid var(--line);padding:12px;border-radius:6px;background:var(--panel-2,var(--face-hi));overflow-wrap:anywhere}
.terminal-panel .terminal-screen-column>.terminal-note{padding:24px 16px}
.terminal-panel .terminal-empty{display:grid;justify-items:start;gap:8px;padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--panel,var(--face))}
.terminal-panel .terminal-empty>.terminal-phosphor{width:24px;height:24px;font-size:24px;color:var(--text-dim);margin-bottom:4px}
.terminal-panel .terminal-empty p{color:var(--text-dim)}
.terminal-panel article{display:grid;gap:8px;padding:16px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.terminal-panel article button{justify-self:start}
.terminal-panel :is(code,.terminal-status){font-variant-numeric:tabular-nums}
.terminal-panel .terminal-phosphor{display:inline-block;width:16px;height:16px;flex-shrink:0;font-family:"Helmsman Phosphor Regular";font-size:16px;font-weight:400;font-style:normal;font-synthesis:none;line-height:1;letter-spacing:normal;text-transform:none;vertical-align:-3px}
.terminal-panel .terminal-phosphor::before{content:attr(data-glyph)}
.terminal-panel button>.terminal-phosphor{margin-right:6px}
.terminal-panel ::selection{background:var(--accent);color:var(--on-accent)}
@media(max-width:800px){.terminal-panel .terminal-columns{grid-template-columns:minmax(0,1fr)}.terminal-panel .terminal-tabs{grid-template-columns:repeat(2,minmax(0,1fr))}.terminal-panel .terminal-screen{height:360px;min-height:240px}.terminal-panel .terminal-send{flex-wrap:wrap}.terminal-panel .terminal-send label{flex-basis:100%}}
@media(max-width:480px){.terminal-panel .terminal-tabs{grid-template-columns:minmax(0,1fr)}.terminal-panel .terminal-toolbar{padding:12px}.terminal-panel .terminal-empty{padding:20px}}
@media(pointer:coarse){.terminal-panel :is(button,input,select){min-height:44px}.terminal-panel .terminal-column-head button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.plugin-terminal button{transition:none}}
`;

export const styles = `
.plugin-bugs{display:grid;gap:12px;color:var(--text);font:16px var(--sans,sans-serif);min-width:0}
.plugin-bugs :is(h1,h2,h3,p){margin:0}
.plugin-bugs h1{font-size:24px}
.plugin-bugs :is(h2,h3){font-size:16px}
.plugin-bugs :is(.bugs-tools,.bugs-toolbar,fieldset){display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.plugin-bugs :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:6px 9px;border-radius:6px;max-width:100%}
.plugin-bugs select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-bugs button{cursor:pointer}
.plugin-bugs button:disabled{opacity:.5}
.plugin-bugs :is(button,select,input,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-bugs section{display:grid;gap:12px;min-width:0;padding:12px;border:1px solid var(--line);border-radius:6px}
.plugin-bugs ul{list-style:none;padding:0;margin:0}
.plugin-bugs li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:9px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.plugin-bugs a{color:var(--accent)}
.plugin-bugs small{color:var(--text-dim)}
.plugin-bugs [role=alert]{color:var(--bad)}
.plugin-bugs dl{display:flex;gap:18px;flex-wrap:wrap}
.plugin-bugs dt{color:var(--text-dim)}
.plugin-bugs dd{margin:4px 0;font-weight:600}
.plugin-bugs table{border-collapse:collapse;text-align:left;overflow-wrap:anywhere;width:100%}
.plugin-bugs :is(th,td){border-bottom:1px solid var(--line);padding:8px;vertical-align:top}
.plugin-bugs .table-scroll{overflow:auto}
.plugin-bugs .bugs-description{display:grid;gap:6px;margin-top:6px}
.plugin-bugs .bugs-description-content{white-space:pre-wrap;overflow-wrap:anywhere}
.plugin-bugs .severity-badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:1px 6px;font-weight:700;line-height:1.35}
.plugin-bugs .severity-s0{color:var(--bad)}
.plugin-bugs .severity-s1{color:var(--bad)}
.plugin-bugs .severity-s2{color:var(--accent)}
.plugin-bugs .severity-s3{color:var(--accent)}
.plugin-bugs .severity-s4{color:var(--text-dim)}
.plugin-bugs .severity-s5{color:var(--text-dim)}
.plugin-bugs { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-bugs :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-bugs h1 { font-size: 26px; }
.plugin-bugs h2 { font-size: 20px; }
.plugin-bugs h3 { font-size: 18px; }
.plugin-bugs :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-bugs button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-bugs button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-bugs button:disabled { cursor: default; opacity: .5; }
.plugin-bugs :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-bugs :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-bugs :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-bugs small { font-size: 14px; }
.plugin-bugs p { max-width: 75ch; }
.plugin-bugs :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-bugs :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-bugs button { transition: none; }
 }
.plugin-bugs section { border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 16px 0; gap: 12px; }
`;

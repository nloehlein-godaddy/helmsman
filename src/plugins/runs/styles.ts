export const styles = `
.plugin-runs{color:var(--text);font:14px/1.5 var(--sans,sans-serif);min-width:0;display:grid;gap:20px}
.plugin-runs :is(h1,h2,h3){margin:0;font-family:var(--sans,sans-serif);line-height:1.3;letter-spacing:-.02em;text-wrap:balance}
.plugin-runs h1{font-size:26px}
.plugin-runs h2{font-size:20px}
.plugin-runs h3{font-size:18px}
.plugin-runs>.runs-stack{min-width:0;display:grid;gap:12px}
.plugin-runs>.runs-history-stack{padding-top:20px;border-top:1px solid var(--line-strong)}
.plugin-runs>.runs-stack>[data-panel-instance]{min-width:0}
.plugin-runs :is(.composition-page-editor,.composition-panel-tabs) :is(button,select){box-sizing:border-box;font:14px/1.4 var(--sans,sans-serif);min-height:32px;color:var(--text);background:var(--panel-hi,var(--face-hi));border:1px solid var(--line-strong);border-radius:6px;padding:6px 10px;max-width:100%}
.plugin-runs .composition-page-editor select{color:var(--input-text,var(--text));background:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}
.plugin-runs button{cursor:pointer}
.plugin-runs button:disabled{opacity:.5;cursor:default}
.plugin-runs>.composition-page-header{margin-bottom:0}
.plugin-runs>.composition-page-editor{margin-bottom:0}
.plugin-runs>[role=alert]{padding:12px 16px;background:var(--panel-2,var(--face-hi));border-radius:6px;color:var(--text)}
.plugin-runs>[role=status]{overflow-wrap:anywhere}
.plugin-runs :is(.composition-page-header,.composition-page-editor,.composition-panel-tabs) :is(button,select):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
@media(pointer:coarse){.plugin-runs :is(.composition-page-editor,.composition-panel-tabs) :is(button,select){min-height:44px}}
`;

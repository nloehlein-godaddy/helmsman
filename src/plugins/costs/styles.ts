export const COSTS_STYLES = `
.helmsman-costs-page { color: var(--text); font: 14px var(--sans, sans-serif); }
.helmsman-costs-page .costs-panel { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.helmsman-costs-page .costs-panel-head { display: flex; align-items: center; gap:12px; padding: 9px 14px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--secondary, var(--text)) 8%, var(--panel)); }
.helmsman-costs-page .costs-panel-title { font-family: var(--sans, sans-serif); text-transform: none; letter-spacing: -.02em; font-weight: 600; font-size: 18px; color: var(--secondary, var(--text)); }
.helmsman-costs-page .costs-empty-note { padding: 14px; color: var(--text-dim); font-size: 12px; font-style: normal; list-style: none; }
.helmsman-costs-page .costs-error-banner { border: 1px solid var(--line-strong); background: color-mix(in srgb,var(--bad) 6%,var(--panel)); color: var(--bad); font-size: 14px; padding: 8px 12px; border-radius: 6px; }
.helmsman-costs-page button { font-family: var(--sans, sans-serif); font-size: 14px; letter-spacing: normal; text-transform: none; color: var(--accent); background: transparent; border: 1px solid var(--line-strong); padding: 5px 12px; cursor: pointer; border-radius: 6px; transition: background 90ms, color 90ms; }
.helmsman-costs-page button:hover { background: var(--accent-plate); color: var(--on-accent); border-color: var(--accent-plate); }
.helmsman-costs-page a { color: var(--accent); text-underline-offset: 3px; }
.helmsman-costs-page {display:grid;gap:16px}
.helmsman-costs-page .outcome-toolbar, .helmsman-costs-page .outcome-stats, .helmsman-costs-page .outcome-run {display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.helmsman-costs-page .outcome-toolbar {justify-content:space-between}
.helmsman-costs-page .outcome-toolbar select, .helmsman-costs-page .outcome-assessment input, .helmsman-costs-page .outcome-assessment select, .helmsman-costs-page .outcome-assessment textarea {background-color:var(--control-bg,var(--face-hi));color:var(--text);border:1px solid var(--control-border,var(--line));border-radius:6px;padding:7px}
.helmsman-costs-page .outcome-stats {display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.helmsman-costs-page .outcome-stat {border:1px solid var(--line);border-radius:6px;padding:12px;display:grid;gap:4px}
.helmsman-costs-page .outcome-stat b {font-size:1.1rem}
.helmsman-costs-page .outcome-stat small {color:var(--text-dim)}
.helmsman-costs-page .outcome-tags {display:flex;gap:8px;flex-wrap:wrap}
.helmsman-costs-page .outcome-tags span {padding:4px 8px;border-radius:6px;background:var(--face-hi);border:1px solid var(--line)}
.helmsman-costs-page .outcome-table {width:100%;border-collapse:collapse}
.helmsman-costs-page .outcome-table th, .helmsman-costs-page .outcome-table td {padding:8px;text-align:left;border-bottom:1px solid var(--line)}
.helmsman-costs-page .outcome-runs {padding:0;margin:0;list-style:none;display:grid;gap:8px}
.helmsman-costs-page .outcome-run {padding:10px;border-bottom:1px solid var(--line)}
.helmsman-costs-page .outcome-assessment {flex-basis:100%}
.helmsman-costs-page .outcome-assessment form {display:grid;gap:8px;margin-top:8px}
.helmsman-costs-page .outcome-assessment label {display:grid;gap:4px}
.helmsman-costs-page .outcome-assessment textarea {min-height:64px;resize:vertical}
.helmsman-costs-page .outcome-inline-error, .helmsman-costs-page .outcome-save-error {color:var(--bad)}
.helmsman-costs-page .outcomes-intro h1 { margin: 0 0 7px; font-size: 18px; }
.helmsman-costs-page .outcomes-intro p { max-width: 75ch; margin: 0; color: var(--text-dim); font-size: 12px; line-height: 1.6; }
.helmsman-costs-page .outcome-help, .helmsman-costs-page .outcome-assessment small { margin: 0; max-width: 75ch; color: var(--text-dim); font-size: 12px; line-height: 1.6; }
.helmsman-costs-page .outcome-assessment summary { cursor: pointer; }
.helmsman-costs-page .outcome-assessment-details > div { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 12px; }
.helmsman-costs-page .outcome-assessment input, .helmsman-costs-page .outcome-assessment textarea, .helmsman-costs-page .outcome-assessment select { width: 100%; min-width: 0; box-sizing: border-box; font: inherit; }
.helmsman-costs-page .outcome-assessment button { justify-self: start; }
.helmsman-costs-page .outcome-assessment :is(summary, input, select, textarea, button):focus-visible, .helmsman-costs-page .outcome-toolbar select:focus-visible, .helmsman-costs-page .outcome-table-wrap:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.helmsman-costs-page .outcome-table-wrap { overflow-x: auto; }
.helmsman-costs-page .outcome-table { min-width: 580px; }
.helmsman-costs-page .outcome-run > a { overflow-wrap: anywhere; }
.helmsman-costs-page, .helmsman-costs-page .outcome-assessment, .helmsman-costs-page .costs-panel { min-width: 0; }
.helmsman-costs-page { font: 14px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.helmsman-costs-page :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.helmsman-costs-page h1 { font-size: 24px; }
.helmsman-costs-page h2 { font-size: 18px; }
.helmsman-costs-page h3 { font-size: 16px; }
.helmsman-costs-page :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 14px/1.4 var(--sans, sans-serif); min-height: 36px; }
.helmsman-costs-page button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.helmsman-costs-page button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.helmsman-costs-page button:disabled { cursor: default; opacity: .5; }
.helmsman-costs-page :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.helmsman-costs-page :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.helmsman-costs-page :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.helmsman-costs-page small { font-size: 12px; }
.helmsman-costs-page p { max-width: 75ch; }
.helmsman-costs-page :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.helmsman-costs-page :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .helmsman-costs-page button { transition: none; }
 }
.helmsman-costs-page .costs-panel { border-radius: 12px; }
.helmsman-costs-page .outcome-stat { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 12px 0; }
.helmsman-costs-page .outcome-stat b { font-size: 16px; font-variant-numeric: tabular-nums; }
.helmsman-costs-page .outcomes-intro h1 { font-size: 24px; }
.helmsman-costs-page .outcomes-intro p { font-size: 14px; }
.helmsman-costs-page button { color: var(--text); }
.helmsman-costs-page button:hover:not(:disabled) { color: var(--text); }
.helmsman-costs-page .outcome-assessment button[type=submit] { color: var(--on-accent); }
`;

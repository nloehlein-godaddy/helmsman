export const COSTS_STYLES = `
.helmsman-costs-page { color: var(--text, #e8e0d0); font: 14px var(--sans, sans-serif); }
.helmsman-costs-page .costs-panel { border: 1px solid var(--line, #555); border-radius: var(--radius, 4px); background: var(--panel, #191b21); }
.helmsman-costs-page .costs-panel-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--line, #555); }
.helmsman-costs-page .costs-panel-title { font-family: var(--mono, monospace); text-transform: uppercase; letter-spacing: .12em; font-weight: 700; font-size: 12px; color: var(--text, #e8e0d0); }
.helmsman-costs-page .costs-empty-note { padding: 14px; color: var(--text-faint, #aaa); font-size: 12px; font-style: normal; list-style: none; }
.helmsman-costs-page .costs-error-banner { border: 1px solid var(--line-strong, #666); background: rgba(245,166,35,.06); color: var(--accent-bright, #f5bd62); font-size: 12px; padding: 8px 12px; border-radius: var(--radius, 4px); }
.helmsman-costs-page button { font-family: var(--mono, monospace); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent, #eeb05d); background: transparent; border: 1px solid var(--line-strong, #666); padding: 5px 12px; cursor: pointer; border-radius: var(--radius, 4px); transition: background 90ms, color 90ms; }
.helmsman-costs-page button:hover { background: var(--accent-plate, #f5bd62); color: #0a0805; border-color: var(--accent-plate, #f5bd62); }
.helmsman-costs-page a { color: var(--accent, #eeb05d); text-underline-offset: 3px; }
.helmsman-costs-page {display:grid;gap:16px}
.helmsman-costs-page .outcome-toolbar, .helmsman-costs-page .outcome-stats, .helmsman-costs-page .outcome-run {display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.helmsman-costs-page .outcome-toolbar {justify-content:space-between}
.helmsman-costs-page .outcome-toolbar select, .helmsman-costs-page .outcome-assessment input, .helmsman-costs-page .outcome-assessment select, .helmsman-costs-page .outcome-assessment textarea {background:var(--face-hi);color:var(--text);border:1px solid var(--line);border-radius:var(--radius);padding:7px}
.helmsman-costs-page .outcome-stats {display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.helmsman-costs-page .outcome-stat {border:1px solid var(--line);border-radius:var(--radius);padding:12px;display:grid;gap:4px}
.helmsman-costs-page .outcome-stat b {font-size:1.1rem}
.helmsman-costs-page .outcome-stat small {color:var(--text-dim)}
.helmsman-costs-page .outcome-tags {display:flex;gap:8px;flex-wrap:wrap}
.helmsman-costs-page .outcome-tags span {padding:4px 8px;border-radius:var(--radius);background:var(--face-hi);border:1px solid var(--line)}
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
`;

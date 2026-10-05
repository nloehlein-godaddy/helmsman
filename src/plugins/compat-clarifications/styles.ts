export const styles = `
.plugin-clarification-recovery .clarification-page { display: grid; gap: 24px; padding: 24px; max-width: 1100px; margin-inline: auto; }
.plugin-clarification-recovery .clarification-page h1 { margin: 0 0 8px; font: 600 26px/1.3 var(--sans,sans-serif); }
.plugin-clarification-recovery .clarification-page h2 { margin: 0; font: 600 20px/1.3 var(--sans,sans-serif); }
.plugin-clarification-recovery .clarification-page h3 { margin: 0; font-size: 19px; line-height: 1.5; }
.plugin-clarification-recovery .clarification-page p { margin: 0; max-width: 72ch; line-height: 1.6; }
.plugin-clarification-recovery .clarification-heading, .plugin-clarification-recovery .clarification-section-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 16px; }
.plugin-clarification-recovery .clarification-heading > div { flex: 1 1 400px; }
.plugin-clarification-recovery .clarification-heading button { flex: 0 0 auto; }
.plugin-clarification-recovery .clarification-list { display: grid; gap: 16px; }
.plugin-clarification-recovery .clarification-card { display: grid; gap: 12px; padding-block: 24px; border-top: 1px solid var(--line); min-width: 0; }
.plugin-clarification-recovery .clarification-card h3, .plugin-clarification-recovery .clarification-answer, .plugin-clarification-recovery .clarification-contacts { overflow-wrap: anywhere; white-space: pre-wrap; }
.plugin-clarification-recovery .clarification-card form, .plugin-clarification-recovery .trusted-contact-form { display: grid; gap: 12px; }
.plugin-clarification-recovery .clarification-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--text-dim); font-size: 14px; overflow-wrap: anywhere; }
.plugin-clarification-recovery .clarification-state { color: var(--accent); font-weight: 700; }
.plugin-clarification-recovery .clarification-help { color: var(--text-dim); font-size: 15px; }
.plugin-clarification-recovery .clarification-empty { display: grid; gap: 8px; padding: 24px 0; border-top: 1px solid var(--line); }
.plugin-clarification-recovery .clarification-empty p { color: var(--text-dim); }
.plugin-clarification-recovery .clarification-page label { display: grid; gap: 6px; }
.plugin-clarification-recovery .clarification-page label:has(input[type="checkbox"]) { display: flex; align-items: center; }
.plugin-clarification-recovery .clarification-page input:not([type="checkbox"]), .plugin-clarification-recovery .clarification-page textarea { width: 100%; box-sizing: border-box; font: inherit; color: var(--text); background-color: var(--control-bg, var(--panel-2)); border: 1px solid var(--control-border, var(--line)); border-radius: 6px; padding: 10px; }
.plugin-clarification-recovery .clarification-page textarea { resize: vertical; min-height: 90px; }
.plugin-clarification-recovery .clarification-page :is(input, textarea, button, summary, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.plugin-clarification-recovery .clarification-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.plugin-clarification-recovery .clarification-actions button { width: auto; }
.plugin-clarification-recovery .clarification-page button { min-height: 36px; cursor: pointer; }
.plugin-clarification-recovery .clarification-page button:disabled { cursor: wait; opacity: .6; }
.plugin-clarification-recovery .clarification-form-error, .plugin-clarification-recovery .clarification-error { color: var(--bad); }
.plugin-clarification-recovery .clarification-notice { color: var(--text); }
.plugin-clarification-recovery .clarification-answer strong { display: block; margin-bottom: 6px; }
.plugin-clarification-recovery .clarification-settings, .plugin-clarification-recovery .clarification-history { border-top: 1px solid var(--line); padding-top: 16px; }
.plugin-clarification-recovery .clarification-page summary { cursor: pointer; color: var(--text-dim); padding-block: 8px; }
.plugin-clarification-recovery .clarification-page summary:hover { color: var(--text); }
.plugin-clarification-recovery .clarification-settings[open] > :not(summary) { margin-top: 16px; }
.plugin-clarification-recovery .clarification-contacts { padding-left: 20px; line-height: 1.6; }
@media (max-width: 600px) {
.plugin-clarification-recovery .clarification-page { padding: 16px; gap: 20px; }
.plugin-clarification-recovery .clarification-heading button, .plugin-clarification-recovery .clarification-actions button { width: 100%; min-height: 44px; }

}
.plugin-clarification-recovery { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.plugin-clarification-recovery :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.plugin-clarification-recovery h1 { font-size: 26px; }
.plugin-clarification-recovery h2 { font-size: 20px; }
.plugin-clarification-recovery h3 { font-size: 18px; }
.plugin-clarification-recovery :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.plugin-clarification-recovery button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.plugin-clarification-recovery button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.plugin-clarification-recovery button:disabled { cursor: default; opacity: .5; }
.plugin-clarification-recovery :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.plugin-clarification-recovery :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-clarification-recovery :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.plugin-clarification-recovery small { font-size: 14px; }
.plugin-clarification-recovery p { max-width: 75ch; }
.plugin-clarification-recovery :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.plugin-clarification-recovery :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .plugin-clarification-recovery button { transition: none; }
 }
`;

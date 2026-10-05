import type { FeedbackContextV1, FeedbackDestinationV1 } from '@helmsman/plugin-sdk';
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const message = (error: unknown) => error instanceof Error ? error.message : 'Feedback is unavailable. Your draft is kept.';
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(value);
export function destination(value: unknown): value is FeedbackDestinationV1 {
  if (!value || typeof value !== 'object') return false; const item = value as Partial<FeedbackDestinationV1>;
  try { const url = new URL(item.url ?? ''); return typeof item.id === 'string' && typeof item.label === 'string' && typeof item.revision === 'string' && /^[a-f\d]{64}$/.test(item.revision) && url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export interface Draft { version: 1; id: string; title: string; body: string; context: FeedbackContextV1; destination: FeedbackDestinationV1 | null; }
export function draft(value: unknown, context: FeedbackContextV1): Draft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved feedback draft is invalid. Its original data is kept.');
  const item = value as Draft;
  if (item.version !== 1 || !uuid(item.id) || typeof item.title !== 'string' || item.title.length > 256 || typeof item.body !== 'string' || item.body.length > 10000
    || !item.context || item.context.repo !== context.repo || typeof item.context.version !== 'string' || typeof item.context.page !== 'string' || item.destination !== null && !destination(item.destination)) throw new Error('Saved feedback draft is invalid. Its original data is kept.');
  return item;
}
export class Storage {
  private raw: string | null;
  private readonly key: string;
  constructor(key: string) { this.key = key; this.raw = localStorage.getItem(key); }
  read(): unknown { if (this.raw === null) return null; if (this.raw.length > 65536) throw new Error('Saved feedback data is too large. Its original data is kept.'); return JSON.parse(this.raw); }
  save(value: unknown) {
    if (localStorage.getItem(this.key) !== this.raw) throw new Error('Feedback was edited in another tab. Reload to read the saved draft.');
    const raw = JSON.stringify(value); if (raw.length > 65536) throw new Error('Feedback data is too large to save.');
    localStorage.setItem(this.key, raw); this.raw = raw;
  }
}
export const styles = `
.product-feedback{max-width:52rem;margin:0 auto;padding:1rem}
.product-feedback label{display:block;margin-top:1rem}
.product-feedback input:not([type=checkbox]),.product-feedback textarea,.product-feedback select{display:block;width:100%;max-width:100%;box-sizing:border-box}
.product-feedback textarea{min-height:12rem}
.product-feedback button{margin:.75rem .5rem .25rem 0}
.product-feedback pre{white-space:pre-wrap;overflow-wrap:anywhere}
.product-feedback a{overflow-wrap:anywhere}
.product-feedback { font: 16px/1.5 var(--sans, sans-serif); color: var(--text); min-width: 0; }
.product-feedback :is(h1,h2,h3) { font-family: var(--sans, sans-serif); line-height: 1.3; letter-spacing: -.02em; text-wrap: balance; }
.product-feedback h1 { font-size: 26px; }
.product-feedback h2 { font-size: 20px; }
.product-feedback h3 { font-size: 18px; }
.product-feedback :is(button,input:not([type=checkbox]):not([type=radio]),select,textarea) { box-sizing: border-box; border-radius: 6px; font: 16px/1.4 var(--sans, sans-serif); min-height: 36px; }
.product-feedback button { padding: 6px 12px; text-transform: none; letter-spacing: normal; transition: background-color 160ms ease-out, border-color 160ms ease-out; }
.product-feedback button:hover:not(:disabled) { background-color: var(--face-hi); border-color: var(--line-strong); }
.product-feedback button:disabled { cursor: default; opacity: .5; }
.product-feedback :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { padding: 6px 12px; color: var(--text); background: var(--control-bg, var(--face-hi)); border: 1px solid var(--control-border, var(--line-strong)); max-width: 100%; }
.product-feedback :is(button,input,select,textarea,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.product-feedback :is(p,small) { line-height: 1.5; overflow-wrap: anywhere; }
.product-feedback small { font-size: 14px; }
.product-feedback p { max-width: 75ch; }
.product-feedback :is(button[type=submit],button.primary-action,button.campaign-primary) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.product-feedback :is(button[type=submit],button.primary-action,button.campaign-primary):hover:not(:disabled) { background: var(--accent-bright, var(--accent)); border-color: var(--accent-bright, var(--accent)); color: var(--on-accent); }
@media(prefers-reduced-motion:reduce) { .product-feedback button { transition: none; }
 }
`;

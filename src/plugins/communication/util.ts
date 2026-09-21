import type { CommunicationDestinationV1 } from '@helmsman/plugin-sdk';
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export interface PrTarget { repo: string; number: number; }
export function target(input: unknown): PrTarget | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  return typeof value.repo === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(value.repo) && !['.', '..'].includes(value.repo.split('/')[1] ?? '') && Number.isSafeInteger(value.number) && Number(value.number) > 0 ? { repo: value.repo, number: Number(value.number) } : null;
}
export function parseTarget(input: string): PrTarget | null {
  const short = /^([^\s/]+\/[^\s/]+)#(\d+)$/.exec(input.trim()); if (short) return target({ repo: short[1], number: Number(short[2]) });
  try { const url = new URL(input.trim()); const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && match ? target({ repo: match[1], number: Number(match[2]) }) : null; } catch { return null; }
}
export function safeSlackUrl(value: unknown): string | null {
  try { if (typeof value !== 'string') return null; const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname.endsWith('.slack.com') && /^\/archives\/[A-Z0-9]+\/p\d+/.test(url.pathname) ? url.href : null; } catch { return null; }
}
export function safePrUrl(value: unknown, repo: string, number: number | null): string | null {
  try { if (typeof value !== 'string' || !number) return null; const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === 'github.com' && url.pathname === `/${repo}/pull/${number}` ? url.href : null; } catch { return null; }
}
export const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
export function relativeTime(value: string): string { const diff = Date.now() - Date.parse(value); return !Number.isFinite(diff) ? 'Unknown time' : diff < 60_000 ? 'just now' : diff < 3_600_000 ? `${Math.floor(diff / 60_000)}m ago` : diff < 86_400_000 ? `${Math.floor(diff / 3_600_000)}h ago` : `${Math.floor(diff / 86_400_000)}d ago`; }
export function runHref(header: string | null, repo: string, runId: string): string { return `/runs?${new URLSearchParams({ ...(header ? { repo: header } : {}), runRepo: repo, run: runId })}`; }
export function validDestination(value: unknown): value is CommunicationDestinationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['providerId', 'artifactHash', 'workspace', 'channel', 'mention', 'connectionId'].every(key => typeof (value as Record<string, unknown>)[key] === 'string');
}
export class Storage {
  private readonly prefix: string;
  constructor(contribution: string | undefined) {
    if (!contribution || !/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(contribution)) throw new Error('Communication storage requires its mounted contribution identity.');
    this.prefix = `helmsman.communication.v1:${contribution}:`;
  }
  read(key: string): unknown { const raw = localStorage.getItem(this.prefix + key); if (raw === null) return null; if (raw.length > 100_000) throw new Error('Stored communication evidence is too large. Its original data is kept.'); return JSON.parse(raw); }
  save(key: string, value: unknown) { const raw = JSON.stringify(value); if (raw.length > 100_000) throw new Error('Communication evidence is too large to save.'); localStorage.setItem(this.prefix + key, raw); }
  result(key: string, value: unknown) { const previous = this.read(`result:${key}`); if (previous !== null && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('Saved communication result changed. Original evidence is kept.'); this.save(`result:${key}`, value); }
  results(): unknown[] { const result: unknown[] = []; for (let index = 0; index < localStorage.length && result.length < 50; index++) { const key = localStorage.key(index); if (key?.startsWith(this.prefix + 'result:')) result.push(this.read(key.slice(this.prefix.length))); } return result; }
}

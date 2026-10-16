import type { PullRequestReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';

type RunSnapshot = { readonly items: readonly RunReadSummaryV1[]; readonly more: boolean };
class ReadCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number; bytes: number }>();
  private bytes = 0;
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { this.delete(key); return null; }
    return structuredClone(entry.value);
  }
  set(key: string, value: T) {
    this.delete(key);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > 4 * 1024 * 1024) return;
    for (const [key, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.delete(key);
    while (this.entries.size >= 32 || this.bytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value; if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + 60_000, bytes }); this.bytes += bytes;
  }
  delete(key: string) { this.bytes -= this.entries.get(key)?.bytes ?? 0; this.entries.delete(key); }
  clear() { this.entries.clear(); this.bytes = 0; }
}
export const listSnapshots = new ReadCache<PullRequestReadPageV1>();
export const runSnapshots = new ReadCache<RunSnapshot>();

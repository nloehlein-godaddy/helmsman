export interface Draft { body: string; feedback: string; model: string; effort: string; }
const empty = (): Draft => ({ body: '', feedback: '', model: '', effort: '' });
const listeners = new Set<(source: PrStorage | null) => void>();
export function subscribeStorage(listener: (source: PrStorage | null) => void): () => void { const external = () => listener(null); listeners.add(listener); window.addEventListener('storage', external); return () => { listeners.delete(listener); window.removeEventListener('storage', external); }; }
export class PrStorage {
  private readonly prefix: string;
  constructor(contribution: string | undefined) {
    if (!contribution || !/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(contribution)) throw new Error('Pull request storage requires its mounted contribution identity.');
    this.prefix = `helmsman.pull-request.v1:${contribution}:`;
  }
  private key(repo: string, number: number) { return `${this.prefix}draft:${JSON.stringify([repo, number])}`; }
  draft(repo: string, number: number): Draft {
    const raw = localStorage.getItem(this.key(repo, number)); if (raw === null) return empty();
    if (raw.length > 100_000) throw new Error('Stored pull request draft is unavailable. Its original data is kept.');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stored pull request draft is unavailable. Its original data is kept.');
    const data = value as Record<string, unknown>;
    if (Object.keys(data).some(key => key !== 'version' && key !== 'draft') || data.version !== 1 || !data.draft || typeof data.draft !== 'object' || Array.isArray(data.draft)) throw new Error('Stored pull request draft is unavailable. Its original data is kept.');
    const draft = data.draft as Record<string, unknown>;
    if (Object.keys(draft).length !== 4 || ['body', 'feedback', 'model', 'effort'].some(key => typeof draft[key] !== 'string')) throw new Error('Stored pull request draft is unavailable. Its original data is kept.');
    return { body: draft.body as string, feedback: draft.feedback as string, model: draft.model as string, effort: draft.effort as string };
  }
  edit(repo: string, number: number, field: keyof Draft, value: string): Draft {
    if (value.length > 20_480) throw new Error('Draft is too long to save. Shorten it before submitting.');
    const draft = { ...this.draft(repo, number), [field]: value };
    localStorage.setItem(this.key(repo, number), JSON.stringify({ version: 1, draft }));
    for (const listener of listeners) listener(this); return draft;
  }
  results(repo: string, number: number): string[] {
    const result: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index); if (!key?.startsWith(`${this.prefix}result:`)) continue;
      const raw = localStorage.getItem(key); if (!raw || raw.length > 200_000) continue;
      const saved = JSON.parse(raw) as { version?: number; value?: { input?: { repo?: string; number?: number; launch?: { prNumber?: number } }; status?: string; result?: { actor?: string }; receipt?: { status?: string; runId?: string | null } } };
      const value = saved?.version === 1 ? saved.value : null;
      if (value?.input?.repo !== repo || (value.input.number ?? value.input.launch?.prNumber) !== number) continue;
      result.push(value.receipt ? `Saved run result: ${value.receipt.status ?? 'unknown'}${value.receipt.runId ? ` · ${value.receipt.runId}` : ''}` : `Saved review result: ${value.status ?? 'unknown'}${value.result?.actor ? ` by ${value.result.actor}` : ''}`);
      if (result.length >= 50) break;
    }
    return result;
  }
  result(kind: 'review' | 'run', repo: string, requestId: string, value: unknown): void {
    const key = `${this.prefix}result:${kind}:${JSON.stringify([repo, requestId])}`;
    const serialized = JSON.stringify({ version: 1, value });
    const previous = localStorage.getItem(key);
    if (previous !== null && previous !== serialized) throw new Error('Stored command result changed. Its original evidence is kept.');
    localStorage.setItem(key, serialized);
  }
}

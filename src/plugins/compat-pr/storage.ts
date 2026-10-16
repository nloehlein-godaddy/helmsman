export interface Draft { body: string; feedback: string; guidance?: string; model: string; effort: string; }
export interface ReviewSettings { model: string; effort: string; }
export interface SavedPrResult {
  id: string; kind: 'run' | 'review'; status: string; runId: string | null; actor: string | null; message: string | null;
  savedAt: number | null; action: string | null; mode: string | null; event: string | null;
}
export const DEFAULT_BRANCH_FEEDBACK = 'update the pr using the provided comment feedback.';
const empty = (): Draft => ({ body: '', feedback: DEFAULT_BRANCH_FEEDBACK, guidance: '', model: '', effort: '' });
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
    if (Object.keys(data).some(key => key !== 'version' && key !== 'draft') || (data.version !== 1 && data.version !== 2) || !data.draft || typeof data.draft !== 'object' || Array.isArray(data.draft)) throw new Error('Stored pull request draft is unavailable. Its original data is kept.');
    const draft = data.draft as Record<string, unknown>;
    if (Object.keys(draft).some(key => !['body', 'feedback', 'guidance', 'model', 'effort'].includes(key)) || ['body', 'feedback', 'model', 'effort'].some(key => typeof draft[key] !== 'string') || draft.guidance !== undefined && typeof draft.guidance !== 'string') throw new Error('Stored pull request draft is unavailable. Its original data is kept.');
    return { body: draft.body as string, feedback: data.version === 1 && !(draft.feedback as string).trim() ? DEFAULT_BRANCH_FEEDBACK : draft.feedback as string, guidance: draft.guidance as string | undefined ?? '', model: draft.model as string, effort: draft.effort as string };
  }
  edit(repo: string, number: number, field: keyof Draft, value: string): Draft {
    if (value.length > 20_480) throw new Error('Draft is too long to save. Shorten it before submitting.');
    const draft = { ...this.draft(repo, number), [field]: value };
    localStorage.setItem(this.key(repo, number), JSON.stringify({ version: 2, draft }));
    for (const listener of listeners) listener(this); return draft;
  }
  results(repo: string, number: number): SavedPrResult[] {
    const result: SavedPrResult[] = [];
    const text = (value: unknown, maximum: number): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      const kind = key?.startsWith(`${this.prefix}result:run:`) ? 'run' : key?.startsWith(`${this.prefix}result:review:`) ? 'review' : null;
      if (!kind || !key) continue;
      const raw = localStorage.getItem(key); if (!raw || raw.length > 200_000) continue;
      let saved: unknown; try { saved = JSON.parse(raw); } catch { continue; }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      const data = saved as { version?: unknown; savedAt?: unknown; value?: { input?: { repo?: unknown; number?: unknown; action?: unknown; event?: unknown; launch?: { prNumber?: unknown; mode?: unknown } }; status?: unknown; reason?: unknown; result?: { actor?: unknown }; receipt?: { status?: unknown; runId?: unknown; message?: unknown } } };
      const value = data.version === 1 ? data.value : null;
      if (value?.input?.repo !== repo || (value.input.number ?? value.input.launch?.prNumber) !== number) continue;
      result.push({ id: key, kind, status: text(kind === 'run' ? value.receipt?.status : value.status, 64) ?? 'unknown',
        runId: kind === 'run' ? text(value.receipt?.runId, 128) : null,
        actor: kind === 'review' ? text(value.result?.actor, 256) : null,
        message: text(kind === 'run' ? value.receipt?.message : value.reason, 2048),
        savedAt: typeof data.savedAt === 'number' && Number.isFinite(data.savedAt) && data.savedAt >= 0 ? data.savedAt : null,
        action: text(value.input.action, 64), mode: text(value.input.launch?.mode, 64), event: text(value.input.event, 64) });
    }
    return result.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).slice(0, 50);
  }
  result(kind: 'review' | 'run', repo: string, requestId: string, value: unknown): void {
    const key = `${this.prefix}result:${kind}:${JSON.stringify([repo, requestId])}`;
    const previous = localStorage.getItem(key);
    if (previous !== null) {
      const saved = JSON.parse(previous) as { version?: unknown; value?: unknown };
      if (saved?.version !== 1 || JSON.stringify(saved.value) !== JSON.stringify(value)) throw new Error('Stored command result changed. Its original evidence is kept.');
      return;
    }
    localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now(), value }));
  }
  reviewSettings(repo: string, number: number, headSha: string): ReviewSettings | null {
    let latest: { settings: ReviewSettings; savedAt: number } | null = null;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index); if (!key?.startsWith(`${this.prefix}result:run:`)) continue;
      const raw = localStorage.getItem(key); if (!raw || raw.length > 200_000) continue;
      let saved: unknown; try { saved = JSON.parse(raw); } catch { continue; }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      const data = saved as { version?: unknown; savedAt?: unknown; value?: { input?: { repo?: unknown; action?: unknown; launch?: { mode?: unknown; prNumber?: unknown; headSha?: unknown; model?: unknown; effort?: unknown } }; receipt?: { status?: unknown } } };
      const input = data.value?.input; const launch = input?.launch;
      if (data.version !== 1 || input?.repo !== repo || input.action !== 'launch' || launch?.mode !== 'review' || launch.prNumber !== number || launch.headSha !== headSha || data.value?.receipt?.status !== 'accepted') continue;
      if (launch.model !== undefined && typeof launch.model !== 'string' || launch.effort !== undefined && typeof launch.effort !== 'string') continue;
      const savedAt = typeof data.savedAt === 'number' && Number.isFinite(data.savedAt) ? data.savedAt : 0;
      if (!latest || savedAt >= latest.savedAt) latest = { settings: { model: launch.model as string | undefined ?? '', effort: launch.effort as string | undefined ?? '' }, savedAt };
    }
    return latest?.settings ?? null;
  }
}

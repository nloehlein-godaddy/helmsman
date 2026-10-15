export interface ReviewRecommendation { repo: string; number: number; runId: string; event: 'APPROVE' | 'REQUEST_CHANGES'; verdict: string; }
const prefix = 'helmsman.review-recommendation.v1:';
export function readRecommendation(id: string, target: { repo: string; number: number }): ReviewRecommendation | null {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) return null;
  const raw = sessionStorage.getItem(`${prefix}${id}`); if (!raw || raw.length > 4096) return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || data.repo !== target.repo || data.number !== target.number
    || typeof data.runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(data.runId)
    || (data.event !== 'APPROVE' && data.event !== 'REQUEST_CHANGES') || typeof data.verdict !== 'string' || !data.verdict.trim() || data.verdict.length > 512
    || typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt) || data.createdAt > Date.now() + 60_000 || data.createdAt < Date.now() - 30 * 60_000) return null;
  return { repo: target.repo, number: target.number, runId: data.runId, event: data.event, verdict: data.verdict };
}
export function clearRecommendation(id: string): void { sessionStorage.removeItem(`${prefix}${id}`); }

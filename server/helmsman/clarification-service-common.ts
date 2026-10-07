import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isContributionId } from '../../src/plugins/manifest';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { persistenceHash, PersistenceValidationError } from './persistence';

export type ClarificationFacet = 'run-instructions' | 'clarification-read' | 'clarification-command' | 'suggested-contact-admin' | 'postmortem';
export type ClarificationServiceReason = 'forbidden' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'conflict' | 'cursor-invalid';
export class ClarificationServiceError extends Error {
  readonly status: number; readonly reason: ClarificationServiceReason;
  constructor(status: number, reason: ClarificationServiceReason) { super(reason); this.status = status; this.reason = reason; }
}
export interface ClarificationAuthority {
  authorize(caller: string, facet: ClarificationFacet): void;
}
export function authorizeClarification(options: ClarificationAuthority, caller: string, facet: ClarificationFacet): void {
  if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
  options.authorize(caller, facet);
}
export function clarificationScope(configured: readonly string[], scopeRepo: unknown, repo: string | null): readonly string[] {
  if (!Array.isArray(configured) || configured.length > 1000) throw new ClarificationServiceError(503, 'service-unavailable');
  const permitted = [...new Set(configured.map(parseTaskRepo))].sort();
  const scope = scopeRepo === null ? null : parseTaskRepo(scopeRepo);
  if (scope !== null && !permitted.includes(scope)) throw new ClarificationServiceError(403, 'forbidden');
  if (repo !== null && (!permitted.includes(repo) || scope !== null && scope !== repo)) throw new ClarificationServiceError(404, 'not-found');
  return repo !== null ? [repo] : scope !== null ? [scope] : permitted;
}
export function clarificationClock(now: () => string): string {
  const value = now();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new PersistenceValidationError('Invalid clarification observation time');
  return new Date(value).toISOString();
}
export function createClarificationCursors() {
  const key = randomBytes(32);
  return {
    binding: persistenceHash,
    encode(binding: string, value: { createdAt: string; id: string }): string {
      const payload = Buffer.from(JSON.stringify({ binding, createdAt: value.createdAt, id: value.id })).toString('base64url');
      return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
    },
    decode(cursor: string, binding: string): { createdAt: string; id: string } {
      try {
        if (cursor.length > 4096) throw new Error();
        const [payload, signature, extra] = cursor.split('.');
        if (!payload || !signature || extra !== undefined) throw new Error();
        const actual = Buffer.from(signature, 'base64url'); const expected = createHmac('sha256', key).update(payload).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        const position = value as Record<string, unknown>;
        if (position.binding !== binding || typeof position.createdAt !== 'string' || !Number.isFinite(Date.parse(position.createdAt))
          || typeof position.id !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(position.id)) throw new Error();
        return { createdAt: position.createdAt, id: position.id };
      } catch { throw new ClarificationServiceError(409, 'cursor-invalid'); }
    },
  };
}

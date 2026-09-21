import { parseTaskRepo } from './tasks';

export type PresentationLocatorV1 =
  | { readonly version: 1; readonly kind: 'run'; readonly repo: string; readonly runId: string }
  | { readonly version: 1; readonly kind: 'legacy-run'; readonly runId: string }
  | { readonly version: 1; readonly kind: 'pull-request'; readonly repo: string; readonly number: number };

export function parsePresentationLocatorV1(input: unknown): PresentationLocatorV1 | null {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid presentation locator.');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) throw new TypeError('Invalid presentation locator.');
  }
  const value = input as Record<string, unknown>;
  if (value.version !== 1) throw new TypeError('Unsupported presentation locator.');
  if (value.kind === 'run' || value.kind === 'legacy-run') {
    if (typeof value.runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(value.runId)) throw new TypeError('Invalid presentation run.');
    return value.kind === 'run'
      ? Object.freeze({ version: 1, kind: 'run', repo: parseTaskRepo(value.repo), runId: value.runId })
      : Object.freeze({ version: 1, kind: 'legacy-run', runId: value.runId });
  }
  if (value.kind !== 'pull-request' || typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number < 1) throw new TypeError('Invalid pull request presentation.');
  return Object.freeze({ version: 1, kind: 'pull-request', repo: parseTaskRepo(value.repo), number: value.number });
}

export function samePresentationLocatorV1(a: PresentationLocatorV1 | null | undefined, b: PresentationLocatorV1 | null | undefined): boolean {
  if (!a || !b) return a == null && b == null;
  if (a.version !== b.version || a.kind !== b.kind) return false;
  if (a.kind === 'pull-request' && b.kind === 'pull-request') return a.repo === b.repo && a.number === b.number;
  if (a.kind === 'run' && b.kind === 'run') return a.repo === b.repo && a.runId === b.runId;
  return a.kind === 'legacy-run' && b.kind === 'legacy-run' && a.runId === b.runId;
}

export function scopedPresentationLocatorV1(input: unknown, repo: string | null): PresentationLocatorV1 | null {
  const locator = parsePresentationLocatorV1(input);
  if (locator && locator.kind !== 'legacy-run' && repo !== null && locator.repo !== parseTaskRepo(repo)) throw new TypeError('Presentation is outside the effective galleon scope.');
  return locator;
}

import { validRepo } from './repo';

export function startupScope(url: URL, repos: readonly string[], saved: string | null | undefined): string | null | undefined {
  if (url.searchParams.has('repo')) {
    const value = url.searchParams.get('repo');
    return value === '' ? null : validRepo(value) ?? undefined;
  }
  if (saved === null) return null;
  const valid = validRepo(saved);
  return valid ? repos.find(repo => repo.toLowerCase() === valid.toLowerCase()) : undefined;
}

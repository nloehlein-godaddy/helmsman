export function validRepo(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const [owner, name, extra] = value.split('/');
  if (extra !== undefined || !owner || !name) return null;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) return null;
  return /^[a-z\d_.-]{1,100}$/i.test(name) && name !== '.' && name !== '..' ? value : null;
}


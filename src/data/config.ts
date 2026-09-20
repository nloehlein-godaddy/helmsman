export interface UiConfig {
  config: Record<string, unknown>;
  overridden: string[];
  jiraTokenSet?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUiConfig(value: unknown): value is UiConfig {
  return isRecord(value) && isRecord(value.config)
    && Object.values(value.config).every(item => item === null || typeof item === 'string'
      || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))
    && Array.isArray(value.overridden) && value.overridden.every(key => typeof key === 'string')
    && (value.jiraTokenSet === undefined || typeof value.jiraTokenSet === 'boolean');
}

export async function getConfig(): Promise<UiConfig | null> {
  try {
    const res: Response = await fetch('/api/config', { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const payload: unknown = await res.json();
    return isUiConfig(payload) ? payload : null;
  } catch {
    return null;
  }
}

export async function setConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res: Response = await fetch('/api/config', {
      method: 'PUT',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      return { ok: false, error: isRecord(body) && typeof body.error === 'string' ? body.error : undefined };
    }
    const body: unknown = await res.json().catch(() => null);
    return isRecord(body) && body.ok === true ? { ok: true } : { ok: false, error: 'Unable to confirm the saved setting. Your draft is kept.' };
  } catch {
    return { ok: false };
  }
}

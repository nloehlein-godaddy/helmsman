export interface TerminalRouteV1 {
  readonly version: 1;
  readonly surface: string | null;
  readonly pane: 'tabs' | 'screen' | null;
}

export function parseTerminalRouteV1(value: unknown): TerminalRouteV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  if (route.version !== 1 || Object.keys(route).some(key => !['version', 'surface', 'pane'].includes(key))) return null;
  const surface = route.surface;
  if (surface !== null && (typeof surface !== 'string' || !/^(?:surface:[1-9]\d*|\d+)$/.test(surface)
    || !Number.isSafeInteger(Number(surface.replace(/^surface:/, ''))))) return null;
  if (route.pane !== null && route.pane !== 'tabs' && route.pane !== 'screen') return null;
  return Object.freeze({ version: 1, surface, pane: route.pane });
}

export function sameTerminalRouteV1(a: unknown, b: unknown): boolean {
  const left = parseTerminalRouteV1(a); const right = parseTerminalRouteV1(b);
  return left?.surface === right?.surface && left?.pane === right?.pane;
}

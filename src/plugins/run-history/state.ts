import type { PanelOpaqueStateV1, RunReadListQueryV1 } from '@helmsman/plugin-sdk';

export interface HistoryState { kind: RunReadListQueryV1['kind']; }
export function readState(input: PanelOpaqueStateV1 | null): HistoryState | null {
  if (input === null) return { kind: 'all' };
  const value = input.value as Record<string, unknown> | null;
  if (input.version !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || !['all', 'running', 'terminal'].includes(String(value.kind))) return null;
  return { kind: value.kind as HistoryState['kind'] };
}
export function saveState(state: HistoryState): PanelOpaqueStateV1 { return { version: 1, value: { kind: state.kind } }; }

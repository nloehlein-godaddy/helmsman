import { expect, it } from 'vitest';
import { parseNativeTerminalSurfaceV1 } from './native-terminal';
import { parseTerminalSnapshotV1 } from './terminal';

const surface = { windowRef: 'window:1', workspaceRef: 'workspace:1', workspaceTitle: 'Work', surfaceRef: 'surface:1', surfaceTitle: 'Agent', type: 'terminal', cwd: null, selected: true };
const tab = { target: { repo: null, surfaceRef: 'surface:1', revision: 'a'.repeat(64) }, title: 'Agent', workspaceTitle: 'Work', type: 'terminal', selected: true, actions: [] };
const snapshot = (extra: object) => parseTerminalSnapshotV1({ version: 1, repo: null, connected: true, quality: 'complete', tabs: [{ ...tab, ...extra }], observedAt: '2026-10-09T12:00:00.000Z' }).tabs[0];

it('accepts providers and snapshots without prompt support and preserves prompt text', () => {
  expect(parseNativeTerminalSurfaceV1(surface).lastPrompt).toBeUndefined();
  expect(snapshot({})?.lastPrompt).toBeUndefined();
  for (const lastPrompt of [null, '', '<b>literal</b>\nnext line']) {
    expect(parseNativeTerminalSurfaceV1({ ...surface, lastPrompt }).lastPrompt).toBe(lastPrompt);
    expect(snapshot({ lastPrompt })?.lastPrompt).toBe(lastPrompt);
  }
});

it('rejects malformed and unbounded prompt metadata', () => {
  for (const lastPrompt of [1, {}, 'bad\0prompt', 'x'.repeat(4097)]) {
    expect(() => parseNativeTerminalSurfaceV1({ ...surface, lastPrompt })).toThrow();
    expect(() => snapshot({ lastPrompt })).toThrow();
  }
  expect(() => snapshot({ lastPrompt: 'x'.repeat(1025) })).toThrow();
});

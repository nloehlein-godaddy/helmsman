// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionControls } from './execution-controls';

const roots: string[] = [];
const connections = new Set<Persistence>();
afterEach(() => { for (const connection of connections) connection.close(); connections.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open(path = ':memory:') { const persistence = openPersistence(path); connections.add(persistence); return { persistence, controls: openExecutionControls(persistence), close() { persistence.close(); connections.delete(persistence); } }; }
const attempt = { runId: 'voyage1', attempt: 1 };
it('persists stop intent across process restart without changing the original record on duplicate requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-controls-')); roots.push(root); const path = join(root, 'state.sqlite');
  const first = open(path); expect(first.controls.isStopRequested(attempt)).toBe(false);
  first.controls.requestStop(attempt);
  const original = first.persistence.sql.prepare('SELECT * FROM execution_controls').all(); first.close();
  const second = open(path); expect(second.controls.isStopRequested(attempt)).toBe(true);
  second.controls.requestStop(attempt); expect(second.persistence.sql.prepare('SELECT * FROM execution_controls').all()).toEqual(original);
});
it('isolates stop requests by both run and attempt without clearing earlier intent for a continuation', () => {
  const { controls } = open(); controls.requestStop(attempt);
  expect(controls.isStopRequested({ ...attempt, attempt: 2 })).toBe(false);
  expect(controls.isStopRequested({ ...attempt, runId: 'voyage2' })).toBe(false);
  controls.requestStop({ ...attempt, attempt: 2 });
  expect(controls.isStopRequested(attempt)).toBe(true); expect(controls.isStopRequested({ ...attempt, attempt: 2 })).toBe(true);
});
it('joins a surrounding transaction so cancelled stop admission leaves no partial intent', () => {
  const { persistence, controls } = open();
  expect(() => persistence.transaction(() => { controls.requestStop(attempt); throw new Error('transaction fault'); })).toThrow('transaction fault');
  expect(controls.isStopRequested(attempt)).toBe(false);
});
it.each([null, {}, { runId: '', attempt: 1 }, { runId: 'voyage1', attempt: 0 }, { runId: 'voyage1', attempt: 1.5 }])('rejects malformed control identity %#', value => {
  const { controls } = open();
  expect(() => controls.requestStop(value as typeof attempt)).toThrow('Invalid execution control identity');
  expect(() => controls.isStopRequested(value as typeof attempt)).toThrow('Invalid execution control identity');
});

// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinFeedbackTrackers } from './plugins/builtin-feedback-trackers';
import { readFeedbackSettings, writeFeedbackSettings } from './plugins/data';
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'feedback-settings-')); roots.push(root); const packages = builtinFeedbackTrackers.map(value => value.package); return { root, packages, read: () => readFeedbackSettings(root, packages) }; }
it('starts disabled, atomically saves tracker-owned fields and selection, and rejects stale settings', () => {
  const f = fixture(); const before = f.read(); expect(before.selected).toBeNull(); expect(before.providers[0]?.values).toEqual({ enabled: false, repository: '', labels: '' });
  const selected = before.providers[0]!.id;
  const after = writeFeedbackSettings(f.root, f.packages, { version: 1, expectedRevision: before.revision, selected, values: { enabled: true, repository: 'org/app', labels: 'feedback' } });
  expect(after.selected).toBe(selected); expect(after.providers[0]?.values.repository).toBe('org/app'); expect(f.read()).toEqual(after);
  expect(() => writeFeedbackSettings(f.root, f.packages, { version: 1, expectedRevision: before.revision, selected: null, values: {} })).toThrow('changed');
  const disabled = writeFeedbackSettings(f.root, f.packages, { version: 1, expectedRevision: after.revision, selected: null, values: {} }); expect(disabled.selected).toBeNull(); expect(disabled.providers[0]?.values.repository).toBe('org/app');
});
it('keeps the full settings transaction unchanged on invalid fields or unknown trackers', () => {
  const f = fixture(); const before = f.read();
  for (const changes of [{ selected: 'example.unknown/issues', values: {} }, { selected: before.providers[0]!.id, values: { enabled: true, repository: 'org/app', token: 'forbidden' } }]) {
    expect(() => writeFeedbackSettings(f.root, f.packages, { version: 1, expectedRevision: before.revision, ...changes })).toThrow(); expect(f.read()).toEqual(before);
  }
});
it('reconciles a lost save response by reading the durable settings and rejects an implicit stale replay', () => {
  const f = fixture(); const before = f.read(); const input = { version: 1, expectedRevision: before.revision, selected: before.providers[0]!.id, values: { enabled: true, repository: 'org/app', labels: 'bug' } };
  writeFeedbackSettings(f.root, f.packages, input);
  const restored = f.read(); expect(restored.selected).toBe(input.selected); expect(restored.providers[0]?.values).toEqual(input.values);
  expect(() => writeFeedbackSettings(f.root, f.packages, input)).toThrow('changed'); expect(f.read()).toEqual(restored);
});

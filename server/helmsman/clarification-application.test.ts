import { describe, expect, it } from 'vitest';
import { clarificationContributionEnabled } from './clarification-application';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { parsePluginPackage } from '../../src/plugins/package';

const catalog = (): PluginCatalog => ({ version: 1, safeMode: false, bindings: {}, plugins: [{ hash: 'a'.repeat(64), package: parsePluginPackage({
  packageVersion: 1, node: { minMajor: 22, maxMajorExclusive: 30 },
  manifest: { manifestVersion: 2, id: 'example.questions', version: '1.0.0', sdkVersion: 1,
    pages: [{ id: 'page', title: 'Questions', slots: [], panes: [], requires: [{ id: 'helmsman/clarification-read', version: 1 }] }],
    panels: [{ id: 'panel', title: 'Answer', contract: { id: 'example/questions', version: 1 }, requires: [{ id: 'helmsman/clarification-command', version: 1 }] }] },
  entries: { page: 'page.js' }, panelEntries: { panel: 'panel.js' },
}) }] });

describe('clarification application authority', () => {
  it('keeps read, answer and global contact authority independent for registered contributions', () => {
    const c = catalog();
    expect(clarificationContributionEnabled(c, 'example.questions/page', 'clarification-read')).toBe(true);
    expect(clarificationContributionEnabled(c, 'example.questions/page', 'clarification-command')).toBe(false);
    expect(clarificationContributionEnabled(c, 'example.questions/panel', 'clarification-command')).toBe(true);
    expect(clarificationContributionEnabled(c, 'example.questions/panel', 'suggested-contact-admin')).toBe(false);
    expect(clarificationContributionEnabled(c, 'example.questions/missing', 'clarification-read')).toBe(false);
  });
  it('revokes catalog removal, safe mode and malformed identities', () => {
    expect(clarificationContributionEnabled({ ...catalog(), safeMode: true }, 'example.questions/page', 'clarification-read')).toBe(false);
    expect(clarificationContributionEnabled({ ...catalog(), plugins: [] }, 'example.questions/page', 'clarification-read')).toBe(false);
    expect(clarificationContributionEnabled(catalog(), '../page', 'clarification-read')).toBe(false);
  });
});

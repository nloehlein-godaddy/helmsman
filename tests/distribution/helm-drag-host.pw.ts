import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fixture } from './isolated-fixture';

interface Layout { revision: number; instances: unknown[]; columns: { instances: string[]; activeInstanceId: string; collapsed: boolean }[][]; }
async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => new Promise<Layout>((resolve, reject) => {
    const open = indexedDB.open('helmsman.composition-layouts', 1); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('layouts', 'readonly'); const read = tx.objectStore('layouts').get('helmsman/helm-page');
      tx.oncomplete = () => { db.close(); resolve(read.result); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}

test('built authored Helm moves whole stacks through public composition services and persists across restart', async ({ page }) => {
  test.setTimeout(120_000);
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const errors: string[] = []; const writes: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await host.installAuthorPackage('plugin-sources/helm', 'example.authored-helm', { buildScript: true });
    await host.cli('select', 'helmsman/helm-page', 'example.authored-helm/page');
    let origin = await host.start();
    await page.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/') && request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/helm?repo=org/a`); await expect(page.locator('.plugin-helm')).toBeVisible();
    await page.goto(`${origin}/config?repo=org/a`);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('helmsman.composition-layouts', 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('layouts', 'readwrite'); tx.objectStore('layouts').put({
          version: 1, compositionId: 'helmsman/helm-page', revision: 7,
          instances: [
            { instanceId: 'recent', contributionId: 'helmsman.recent/panel', hidden: false, scope: { kind: 'galleon', repo: 'org/b' }, state: { retained: { version: 1, value: { opaque: 'authored stack' } } } },
            { instanceId: 'hidden', contributionId: 'helmsman.recent/panel', hidden: true, scope: { kind: 'inherit' }, state: {} },
            { instanceId: 'running', contributionId: 'helmsman.running/panel', hidden: false, scope: { kind: 'inherit' }, state: {} },
          ], columns: [[{ instances: ['recent', 'hidden'], activeInstanceId: 'recent', collapsed: true }], [{ instances: ['running'], activeInstanceId: 'running', collapsed: false }]],
        });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }));
    await page.goto(`${origin}/helm?repo=org/a`);
    const root = page.locator('[data-plugin-page="example.authored-helm/page"]'); const grip = root.locator('[data-helm-focus="recent:move"]');
    await expect(root).toBeVisible(); await expect(grip).toBeVisible(); const original = await layout(page);
    await grip.focus(); await grip.press('Space'); await expect(grip).toHaveAttribute('aria-pressed', 'true'); await grip.press('ArrowRight'); await grip.press('End'); await grip.press('Enter');
    await expect.poll(async () => (await layout(page)).columns.map(column => column.map(stack => stack.activeInstanceId))).toEqual([[], ['running', 'recent']]);
    await expect(root.locator('.helm-sr-only[aria-live="polite"]')).toContainText('Panel moved.');
    const saved = await layout(page); expect(saved.instances).toEqual(original.instances); expect(saved.columns[1]?.[1]).toEqual(original.columns[0]?.[0]); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await grip.press('Enter'); await grip.press('ArrowLeft'); await grip.press('Escape'); expect(await layout(page)).toEqual(saved);
    await page.reload(); await expect(grip).toBeVisible(); expect(await layout(page)).toEqual(saved);
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start(); await page.reload(); await expect(grip).toBeVisible(); expect(await layout(page)).toEqual(saved);
    await root.locator('[data-helm-focus="recent:collapse"]').click(); await expect(root.locator('[data-helm-focus="recent:collapse"]')).toHaveAttribute('aria-expanded', 'true');
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

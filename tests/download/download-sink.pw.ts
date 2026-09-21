import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

let server: Server; let origin: string;
test.beforeAll(async () => {
  const adapter = ts.transpileModule(await readFile('src/plugins/download-service.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  const worker = await readFile('public/plugin-download/worker.js', 'utf8');
  server = createServer((request, response) => {
    if (request.url === '/download-service.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(adapter); }
    else if (request.url === '/plugin-download/worker.js') { response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(worker); }
    else if (request.url?.startsWith('/plugin-download/file/')) { response.writeHead(410); response.end('Unavailable'); }
    else { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><button id="download">Download</button><button id="cancel">Cancel</button><p id="result"></p>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function prepare(page: import('@playwright/test').Page, count: number, slow = false, repeats = 4096) {
  await page.goto(origin);
  await page.evaluate(async ({ count, slow, repeats }) => {
    const browser = window as typeof window & { probe?: Record<string, unknown>; showSaveFilePicker?: unknown };
    Object.defineProperty(browser, 'showSaveFilePicker', { configurable: true, value: undefined });
    const { createHostDownloadService } = await import('/download-service.js');
    const lifetime = new AbortController(); const activity = new AbortController(); let index = 0; let reads = 0; let outstanding = 0; let maxOutstanding = 0; let cancelled = false;
    const service = createHostDownloadService(lifetime.signal, () => ({ epoch: 0, repo: 'org/a', active: !activity.signal.aborted, signal: activity.signal }));
    browser.probe = { reads: 0, maxOutstanding: 0, cancelled: false };
    document.querySelector('#cancel')!.addEventListener('click', () => activity.abort());
    document.querySelector('#download')!.addEventListener('click', () => {
      void service.save({ filename: 'run-stream.log', contentType: 'text/plain; charset=utf-8', open: async () => new ReadableStream<Uint8Array>({
        async pull(controller) {
          reads++; outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
          if (slow) await new Promise(resolve => setTimeout(resolve, 20)); outstanding--;
          browser.probe = { reads, maxOutstanding, cancelled };
          if (cancelled) return;
          if (index++ < count) controller.enqueue(new TextEncoder().encode(('😀-line-' + index + '\n').repeat(repeats))); else controller.close();
        }, cancel() { cancelled = true; browser.probe = { reads, maxOutstanding, cancelled }; },
      }, { highWaterMark: 0 }) }).then((result: unknown) => { document.querySelector('#result')!.textContent = JSON.stringify(result); });
    });
  }, { count, slow, repeats });
}

test('streams a complete Unicode log into an actual browser download with one outstanding source read', async ({ page }) => {
  await prepare(page, 512); const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click(); const download = await pending;
  const path = await download.path(); if (!path) throw new Error('No completed download'); const actual = await readFile(path);
  const expected = Buffer.concat(Array.from({ length: 512 }, (_, index) => Buffer.from(('😀-line-' + (index + 1) + '\n').repeat(4096))));
  expect(actual.length).toBe(28917760); expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
  expect(download.suggestedFilename()).toBe('run-stream.log'); await expect(page.locator('#result')).toHaveText(JSON.stringify({ status: 'delivered-to-browser', bytesWritten: expected.length }));
  expect(await page.evaluate(() => (window as typeof window & { probe: unknown }).probe)).toEqual({ reads: 513, maxOutstanding: 1, cancelled: false });
});

test('splits coalesced source chunks across bounded worker messages without losing bytes', async ({ page }) => {
  await prepare(page, 8, false, 32768); const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click(); const download = await pending;
  const path = await download.path(); if (!path) throw new Error('No completed download'); const actual = await readFile(path);
  const expected = Buffer.concat(Array.from({ length: 8 }, (_, index) => Buffer.from(('😀-line-' + (index + 1) + '\n').repeat(32768))));
  expect(actual.equals(expected)).toBe(true); await expect(page.locator('#result')).toHaveText(JSON.stringify({ status: 'delivered-to-browser', bytesWritten: expected.length }));
  expect(await page.evaluate(() => (window as typeof window & { probe: unknown }).probe)).toEqual({ reads: 9, maxOutstanding: 1, cancelled: false });
});

test('scope cancellation stops the source and fails the native download where browser completion is observable', async ({ page, browserName }) => {
  await prepare(page, 10000, true); const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click(); const download = await pending;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('#result')).toContainText('cancelled-stream');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { probe: { cancelled: boolean } }).probe.cancelled)).toBe(true);
  const reads = await page.evaluate(() => (window as typeof window & { probe: { reads: number } }).probe.reads); await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as typeof window & { probe: { reads: number } }).probe.reads)).toBe(reads);
  if (browserName === 'firefox') await download.cancel(); else expect(await download.failure()).toBeTruthy();
});

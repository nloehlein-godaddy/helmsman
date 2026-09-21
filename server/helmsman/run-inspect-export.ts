import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runInspectFailure, runInspectTarget } from './run-inspect-routes';
import type { RunInspectServerService } from './run-inspect-service';

export async function handleRunInspectExport(req: IncomingMessage, res: ServerResponse, url: URL, service?: RunInspectServerService): Promise<boolean> {
  const match = /^\/api\/run-inspect\/([a-z\d_-]{1,128})\/export$/i.exec(url.pathname);
  if (!match) return false;
  if (req.method !== 'GET' || !service) {
    res.writeHead(req.method !== 'GET' ? 405 : 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'service-unavailable' })); return true;
  }
  const controller = new AbortController(); const cancel = () => controller.abort();
  req.once('aborted', cancel); res.once('close', cancel);
  try {
    const result = service.openExport({ version: 1, target: runInspectTarget(match[1]!, url.searchParams), scopeRepo: url.searchParams.get('scopeRepo') });
    res.writeHead(200, { 'Content-Type': result.metadata.contentType, 'Content-Disposition': `attachment; filename="${result.metadata.filename}"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Helmsman-Run-Inspect': encodeURIComponent(JSON.stringify(result.metadata)) });
    await pipeline(Readable.from(result.chunks(controller.signal), { objectMode: false, highWaterMark: 65536 }), res, { signal: controller.signal });
  } catch (error) {
    if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
    else { const failure = runInspectFailure(error); res.writeHead(failure.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(failure.json)); }
  } finally { req.off('aborted', cancel); res.off('close', cancel); }
  return true;
}

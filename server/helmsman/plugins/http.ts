import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { isPluginAssetPath } from '../../../src/plugins/package';
import type { PluginSnapshot } from './store';

const mime: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

export function handlePluginRequest(req: IncomingMessage, res: ServerResponse, url: URL, snapshot: PluginSnapshot): boolean {
  const rawPath = (req.url ?? url.pathname).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
  const rawAsset = /^\/plugin-assets(?:[/\\]|$)/.test(rawPath);
  const catalog = url.pathname === '/api/plugins/catalog';
  if (!catalog && !rawAsset && url.pathname !== '/plugin-assets' && !url.pathname.startsWith('/plugin-assets/')) return false;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (rawAsset && rawPath !== url.pathname) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('Plugin asset not found.'); return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true;
  }
  if (catalog) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(snapshot.catalog));
    return true;
  }
  const match = /^\/plugin-assets\/([a-z0-9.-]+)\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
  const path = match?.[3];
  const artifact = match ? snapshot.artifacts.get(`${match[1]}/${match[2]}`) : undefined;
  const bytes = path && isPluginAssetPath(path) ? artifact?.files.get(path) : undefined;
  if (!bytes || !path) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('Plugin asset not found.'); return true;
  }
  res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
  return true;
}

import { execFile } from 'node:child_process';
import type { CommunicationBrowserSessionV1 } from '../../src/plugins/communication-provider';

export type CommunicationBrowserTransport = (args: readonly string[], signal: AbortSignal) => Promise<string>;

const execute: CommunicationBrowserTransport = (args, signal) => new Promise((resolve, reject) => {
  execFile('cmux', [...args], { signal, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, CMUX_QUIET: '1' } }, (error, stdout) => {
    if (error) reject(new Error('Communication browser command failed.'));
    else resolve(stdout);
  });
});

function bounded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0')) throw new TypeError('Invalid browser argument.');
  return value;
}

export function createCommunicationBrowserSession(options: {
  workspace: string; surface: string | null; signal: AbortSignal; transport?: CommunicationBrowserTransport;
}): CommunicationBrowserSessionV1 {
  if (!/^[A-Z\d]{3,32}$/.test(options.workspace)) throw new TypeError('Invalid browser workspace.');
  const transport = options.transport ?? execute;
  const known = new Set<string>();
  const matching = new Set<string>();
  let selected: string | null = null;
  const surface = (value: unknown): string => {
    const result = bounded(value, 128);
    if (!/^(?:surface:[1-9]\d*|[a-f\d-]{36})$/i.test(result)) throw new TypeError('Invalid browser surface.');
    return result;
  };
  const configured = options.surface === null ? null : surface(options.surface);
  async function command(args: readonly string[]): Promise<string> {
    options.signal.throwIfAborted();
    const value = await transport(args, options.signal);
    options.signal.throwIfAborted();
    return value;
  }
  function current(input: unknown): string {
    const target = surface(input);
    if (!matching.has(target) || selected !== null && selected !== target || configured !== null && configured !== target)
      throw new Error('Browser surface is outside the retained connection.');
    selected = target;
    return target;
  }
  const guard = `const u = new URL(location.href); if (u.origin !== 'https://app.slack.com' || !u.pathname.startsWith('/client/${options.workspace}/')) throw new Error('Browser workspace changed.');`;
  async function evaluate(target: string, script: string): Promise<unknown> {
    const stdout = await command(['browser', target, 'eval', `(() => { ${guard} return (${bounded(script, 1024 * 1024)}); })()`]);
    return JSON.parse(stdout) as unknown;
  }
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return Object.freeze<CommunicationBrowserSessionV1>({
    async tree() {
      const tree: unknown = JSON.parse(await command(['--id-format', 'both', 'tree', '--all', '--json']));
      const visit = (input: unknown, depth: number) => {
        if (depth > 12) throw new Error('Invalid browser tree.');
        if (Array.isArray(input)) { for (const child of input) visit(child, depth + 1); return; }
        const node = object(input); if (!node) return;
        for (const key of ['ref', 'id', 'surface_ref', 'selected_surface_ref']) {
          try { known.add(surface(node[key])); } catch {}
        }
        if (node.type === 'browser' && typeof node.url === 'string') {
          try {
            const url = new URL(node.url);
            if (url.origin === 'https://app.slack.com' && url.pathname.startsWith(`/client/${options.workspace}/`)) {
              for (const key of ['ref', 'id']) {
                try { matching.add(surface(node[key])); } catch {}
              }
            }
          } catch {}
        }
        for (const key of ['windows', 'workspaces', 'panes', 'surfaces', 'active']) if (node[key]) visit(node[key], depth + 1);
      };
      known.clear(); matching.clear(); visit(tree, 0);
      return tree;
    },
    async focus(input) {
      const target = surface(input?.surface);
      if (!known.has(target)) throw new Error('Unknown browser focus target.');
      await command(['rpc', 'surface.focus', JSON.stringify({ surface_id: target })]);
    },
    async evaluate(input) { return evaluate(current(input?.surface), bounded(input?.script, 1024 * 1024)); },
    async click(input) {
      const target = current(input?.surface); const selector = bounded(input?.selector, 8192);
      await evaluate(target, 'JSON.stringify(true)');
      await command(['browser', target, 'click', selector]);
    },
    async fill(input) {
      const target = current(input?.surface); const selector = bounded(input?.selector, 8192);
      const value = typeof input?.value === 'string' && input.value === '' ? '' : bounded(input?.value, 128 * 1024);
      await evaluate(target, 'JSON.stringify(true)');
      await command(['browser', target, 'fill', selector, value]);
    },
    async wait(input) {
      const target = current(input?.surface); const selector = bounded(input?.selector, 8192);
      if (!Number.isSafeInteger(input?.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 15_000) throw new TypeError('Invalid browser wait.');
      await evaluate(target, 'JSON.stringify(true)');
      await command(['browser', target, 'wait', '--selector', selector, '--timeout-ms', String(input.timeoutMs)]);
    },
  });
}

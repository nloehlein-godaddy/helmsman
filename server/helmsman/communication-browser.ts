import type { CommunicationBrowserSessionV1 } from '../../src/plugins/communication-provider';
import { parseNativeTerminalReferenceV1, type NativeTerminalBrowserV1 } from '../../src/plugins/native-terminal';

function bounded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0')) throw new TypeError('Invalid browser argument.');
  return value;
}

export function createCommunicationBrowserSession(options: {
  workspace: string; surface: string | null; signal: AbortSignal; browser: NativeTerminalBrowserV1; sessionIdentity(): string;
}): CommunicationBrowserSessionV1 {
  if (!/^[A-Z\d]{3,32}$/.test(options.workspace)) throw new TypeError('Invalid browser workspace.');
  if (!options.browser) throw new TypeError('Communication browser provider is unavailable.');
  const known = new Set<string>();
  const matching = new Set<string>();
  let selected: string | null = null;
  const identity = options.sessionIdentity();
  const assertSession = () => {
    if (options.sessionIdentity() !== identity) throw new Error('Communication browser native session changed.');
  };
  const surface = (value: unknown): string => parseNativeTerminalReferenceV1(value);
  const configured = options.surface === null ? null : surface(options.surface);
  async function command<T>(operation: () => Promise<T>): Promise<T> {
    options.signal.throwIfAborted(); assertSession();
    const value = await operation();
    options.signal.throwIfAborted(); assertSession();
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
    return command(() => options.browser.evaluate({ surface: target, script: `(() => { ${guard} return (${bounded(script, 1024 * 1024)}); })()` }, options.signal));
  }
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return Object.freeze<CommunicationBrowserSessionV1>({
    async tree() {
      const tree = await command(() => options.browser.tree(options.signal));
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
      await command(() => options.browser.focus({ surface: target }, options.signal));
    },
    async evaluate(input) { return evaluate(current(input?.surface), bounded(input?.script, 1024 * 1024)); },
    async click(input) {
      const target = current(input?.surface); const selector = bounded(input?.selector, 8192);
      await evaluate(target, 'JSON.stringify(true)');
      await command(() => options.browser.click({ surface: target, selector }, options.signal));
    },
    async fill(input) {
      const target = current(input?.surface); const selector = bounded(input?.selector, 8192);
      const value = typeof input?.value === 'string' && input.value === '' ? '' : bounded(input?.value, 128 * 1024);
      await evaluate(target, 'JSON.stringify(true)');
      await command(() => options.browser.fill({ surface: target, selector, value }, options.signal));
    },
    async wait(input) {
      const target = current(input?.surface); const selector = bounded(input?.selector, 8192);
      if (!Number.isSafeInteger(input?.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 15_000) throw new TypeError('Invalid browser wait.');
      await evaluate(target, 'JSON.stringify(true)');
      await command(() => options.browser.wait({ surface: target, selector, timeoutMs: input.timeoutMs }, options.signal));
    },
  });
}

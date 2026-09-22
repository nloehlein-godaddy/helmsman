import { createHash, randomUUID } from "node:crypto";
import type {
  NativeTerminalBrowserV1,
  NativeTerminalProviderV1,
  NativeTerminalSurfaceV1,
} from "@helmsman/plugin-sdk";
import { connectFirefoxBidi, type FirefoxBidiClient } from "./firefox-bidi.js";

const MAX_CONTEXTS = 4096;
const TIMEOUT_MS = 15_000;
const UNAVAILABLE =
  "Firefox background automation disconnected. Check Firefox and restart the local bridge if needed.";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Connector = (
  url: string,
  signal?: AbortSignal,
) => Promise<FirefoxBidiClient>;

interface Context {
  readonly id: string;
  readonly ref: string;
  readonly url: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
    ? value
    : null;
}
function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function firefoxBidiEndpoint(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096)
    throw new Error("Firefox BiDi must use a local WebSocket endpoint.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Firefox BiDi must use a local WebSocket endpoint.");
  }
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/session\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      url.pathname,
    )
  )
    throw new Error(
      "Firefox BiDi must use a credential-free local WebSocket endpoint without query parameters.",
    );
  return url.href;
}

function contextRef(id: string): string {
  return `firefox:${encodeURIComponent(id)}`;
}

function controlScript(
  selector: string,
  operation: "click" | "fill" | "wait",
  value?: string,
): string {
  return `(() => {
    const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(item => {
      const target = item; const style = getComputedStyle(target);
      return target.isConnected && target.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (!(element instanceof HTMLElement) || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
    if (${JSON.stringify(operation)} === 'wait') return true;
    if (${JSON.stringify(operation)} === 'click') {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const bounds = element.getBoundingClientRect(); const width = innerWidth; const height = innerHeight;
      if (![bounds.left, bounds.top, bounds.right, bounds.bottom, width, height].every(Number.isFinite)) return false;
      const left = Math.max(0, bounds.left); const top = Math.max(0, bounds.top); const right = Math.min(width, bounds.right); const bottom = Math.min(height, bounds.bottom);
      if (right <= left || bottom <= top) return false;
      const x = Math.floor((left + right) / 2); const y = Math.floor((top + bottom) / 2); const hit = document.elementFromPoint(x, y);
      return hit && element.contains(hit) ? { x, y } : false;
    }
    const text = ${JSON.stringify(value ?? "")};
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.readOnly) return false;
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(element, text); element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text })); element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value === text;
    }
    if (!element.isContentEditable || typeof document.execCommand !== 'function') return false;
    if (element.textContent === text) return true;
    const selection = getSelection(); if (!selection) return false;
    element.focus({ preventScroll: true }); const range = document.createRange(); range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
    return document.execCommand(text ? 'insertText' : 'delete', false, text);
  })()`;
}

export interface FirefoxNativeTerminalOptions {
  readonly bidiEndpoint?: string;
  readonly connect?: Connector;
  readonly startup?: string;
}

export interface FirefoxNativeTerminal extends NativeTerminalProviderV1 {
  dispose(): Promise<void>;
}

export function createFirefoxNativeTerminal(
  options: FirefoxNativeTerminalOptions = {},
): FirefoxNativeTerminal {
  const configuredBidiEndpoint = options.bidiEndpoint ?? "";
  const connect = options.connect ?? connectFirefoxBidi;
  const startup = options.startup ?? randomUUID();
  let generation = 0;
  let disposed = false;
  let connecting: Promise<FirefoxBidiClient> | null = null;
  let current: FirefoxBidiClient | null = null;
  let contexts = new Map<string, Context>();
  let selected: string | null = null;

  const invalidate = (): void => {
    const hadState =
      current !== null ||
      connecting !== null ||
      contexts.size > 0 ||
      selected !== null;
    contexts = new Map();
    selected = null;
    connecting = null;
    if (current) {
      const client = current;
      current = null;
      try {
        client.close();
      } catch {}
    }
    if (hadState) generation++;
  };
  const sessionIdentity = () => {
    if (current?.closed) invalidate();
    return hash({
      kind: "firefox",
      bidiEndpoint: configuredBidiEndpoint,
      startup,
      generation,
    });
  };
  const connected = async (
    signal?: AbortSignal,
  ): Promise<FirefoxBidiClient> => {
    abort(signal);
    if (disposed)
      throw new Error("Firefox native browser provider is disposed.");
    if (current?.closed) invalidate();
    if (current) return current;
    if (connecting) return connecting;
    const initialGeneration = generation;
    const pending = (async () => {
      const endpoint = firefoxBidiEndpoint(configuredBidiEndpoint);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      let client: FirefoxBidiClient | null = null;
      try {
        client = await connect(endpoint, requestSignal);
        abort(signal);
        if (disposed || generation !== initialGeneration) {
          try {
            client.close();
          } catch {}
          throw new Error(
            "Firefox native browser session changed during connection.",
          );
        }
        current = client;
        return client;
      } catch (error) {
        if (client)
          try {
            client.close();
          } catch {}
        throw error;
      }
    })();
    connecting = pending;
    try {
      return await pending;
    } catch (error) {
      invalidate();
      throw error;
    } finally {
      if (connecting === pending) connecting = null;
    }
  };
  interface Bridge {
    readonly client: FirefoxBidiClient;
    readonly generation: number;
  }
  const disconnected = (): Error => new Error(UNAVAILABLE);
  const invalidateBridge = (bridge: Bridge): void => {
    if (current === bridge.client && generation === bridge.generation)
      void invalidate();
  };
  const activeBridge = async (signal?: AbortSignal): Promise<Bridge> => {
    abort(signal);
    if (disposed)
      throw new Error("Firefox native browser provider is disposed.");
    if (current?.closed) {
      await invalidate();
      throw disconnected();
    }
    if (!current) throw disconnected();
    return { client: current, generation };
  };
  const requestBridge = async (
    bridge: Bridge,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (
      current !== bridge.client ||
      generation !== bridge.generation ||
      bridge.client.closed
    ) {
      invalidateBridge(bridge);
      throw disconnected();
    }
    try {
      const value = await bridge.client.request(
        method,
        params,
        TIMEOUT_MS,
        signal,
      );
      abort(signal);
      if (
        current !== bridge.client ||
        generation !== bridge.generation ||
        bridge.client.closed
      ) {
        invalidateBridge(bridge);
        throw disconnected();
      }
      return value;
    } catch (error) {
      invalidateBridge(bridge);
      throw error;
    }
  };
  const request = async (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const client = await connected(signal);
    const bridge = { client, generation };
    return requestBridge(bridge, method, params, signal);
  };
  const evaluate = async (
    bridge: Bridge,
    context: Context,
    expression: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    try {
      const value = record(
        await requestBridge(
          bridge,
          "script.evaluate",
          {
            expression: `(async () => { const value = await (${expression}); return JSON.stringify(value === undefined ? null : value); })()`,
            target: { context: context.id },
            awaitPromise: true,
            userActivation: false,
            resultOwnership: "none",
          },
          signal,
        ),
      );
      const result = record(value?.result);
      if (
        value?.type !== "success" ||
        result?.type !== "string" ||
        typeof result.value !== "string" ||
        result.value.length > 4 * 1024 * 1024
      )
        throw new Error(
          "Firefox could not complete the background browser operation.",
        );
      return JSON.parse(result.value) as unknown;
    } catch (error) {
      invalidateBridge(bridge);
      if (
        error instanceof Error &&
        error.message !== "Unexpected end of JSON input"
      )
        throw error;
      throw new Error("Firefox returned an invalid background browser result.");
    }
  };
  const known = (surface: string): Context => {
    const context = contexts.get(surface);
    if (!context)
      throw new Error(
        "Firefox browser surface is unknown. Refresh browser discovery.",
      );
    return context;
  };
  const tree = async (signal?: AbortSignal) => {
    try {
      const value = record(
        await request("browsingContext.getTree", { maxDepth: 0 }, signal),
      );
      if (
        !Array.isArray(value?.contexts) ||
        value.contexts.length > MAX_CONTEXTS
      )
        throw new Error("Firefox returned invalid background tab discovery.");
      const next = new Map<string, Context>();
      for (const item of value.contexts) {
        const raw = record(item);
        const id = text(raw?.context, 4096);
        const url = text(raw?.url, 4096);
        if (!id || !url || (raw?.parent !== null && raw?.parent !== undefined))
          throw new Error("Firefox returned an invalid background tab.");
        const ref = contextRef(id);
        if (next.has(ref))
          throw new Error("Firefox returned duplicate background tabs.");
        next.set(ref, { id, ref, url });
      }
      contexts = next;
      if (!selected || !contexts.has(selected))
        selected = contexts.keys().next().value ?? null;
      const surfaces = [...contexts.values()].map((context) => ({
        ref: context.ref,
        id: context.ref,
        type: "browser",
        url: context.url,
      }));
      return {
        active: { surface_ref: selected },
        windows: [
          {
            workspaces: [
              { panes: [{ selected_surface_ref: selected, surfaces }] },
            ],
          },
        ],
      };
    } catch (error) {
      void invalidate();
      throw error;
    }
  };
  const browser: NativeTerminalBrowserV1 =
    Object.freeze<NativeTerminalBrowserV1>({
      tree,
      async focus(input, signal) {
        abort(signal);
        known(input.surface);
        await activeBridge(signal);
        selected = input.surface;
        abort(signal);
      },
      async evaluate(input, signal) {
        const context = known(input.surface);
        return evaluate(
          await activeBridge(signal),
          context,
          input.script,
          signal,
        );
      },
      async click(input, signal) {
        const context = known(input.surface);
        const bridge = await activeBridge(signal);
        const point = record(
          await evaluate(
            bridge,
            context,
            controlScript(input.selector, "click"),
            signal,
          ),
        );
        const x = point?.x;
        const y = point?.y;
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isSafeInteger(x) ||
          !Number.isSafeInteger(y) ||
          x < 0 ||
          y < 0
        )
          throw new Error(
            "Firefox browser control is unavailable or changed. Retry after the page settles.",
          );
        await requestBridge(
          bridge,
          "input.performActions",
          {
            context: context.id,
            actions: [
              {
                type: "pointer",
                id: "helmsman-firefox-pointer",
                parameters: { pointerType: "mouse" },
                actions: [
                  {
                    type: "pointerMove",
                    x,
                    y,
                    duration: 0,
                    origin: "viewport",
                  },
                  { type: "pointerDown", button: 0 },
                  { type: "pointerUp", button: 0 },
                ],
              },
            ],
          },
          signal,
        );
      },
      async fill(input, signal) {
        const context = known(input.surface);
        const bridge = await activeBridge(signal);
        if (
          (await evaluate(
            bridge,
            context,
            controlScript(input.selector, "fill", input.value),
            signal,
          )) !== true
        )
          throw new Error(
            "Firefox browser control is unavailable or changed. Retry after the page settles.",
          );
      },
      async wait(input, signal) {
        const context = known(input.surface);
        const bridge = await activeBridge(signal);
        const deadline = Date.now() + input.timeoutMs;
        do {
          if (
            (await evaluate(
              bridge,
              context,
              controlScript(input.selector, "wait"),
              signal,
            )) === true
          )
            return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise<void>((resolve, reject) => {
            const cancel = () => {
              clearTimeout(timer);
              reject(
                signal?.reason ?? new Error("Firefox browser wait aborted."),
              );
            };
            const timer = setTimeout(
              () => {
                signal?.removeEventListener("abort", cancel);
                resolve();
              },
              Math.min(100, remaining),
            );
            signal?.addEventListener("abort", cancel, { once: true });
          });
        } while (Date.now() < deadline);
        throw new Error(
          "Firefox browser control did not appear before the timeout.",
        );
      },
    });
  return Object.freeze<FirefoxNativeTerminal>({
    metadata: { version: 1 as const, label: "Firefox", browser: true },
    sessionIdentity,
    async listTabs(signal) {
      try {
        await tree(signal);
        const surfaces = [...contexts.values()];
        return {
          connected: true,
          tabs: surfaces.map(
            (context) =>
              ({
                windowRef: "firefox:window",
                workspaceRef: "firefox:workspace",
                workspaceTitle: "Firefox",
                surfaceRef: context.ref,
                surfaceTitle: context.url,
                type: "browser",
                cwd: null,
                selected: context.ref === selected,
              }) satisfies NativeTerminalSurfaceV1,
          ),
        };
      } catch {
        return { connected: false, tabs: [] };
      }
    },
    async readScreen() {
      return {
        ok: false as const,
        error: "Firefox does not provide terminal screen controls.",
      };
    },
    async send() {
      return {
        ok: false as const,
        error: "Firefox does not provide terminal input controls.",
      };
    },
    async sendKey() {
      return {
        ok: false as const,
        error: "Firefox does not provide terminal input controls.",
      };
    },
    browser,
    async dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
    },
  });
}

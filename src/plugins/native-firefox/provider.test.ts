import { describe, expect, it, vi } from "vitest";
import { createFirefoxNativeTerminal, firefoxBidiEndpoint } from "./provider";
import type { FirefoxBidiClient } from "./firefox-bidi";

const endpoint =
  "ws://127.0.0.1:9222/session/00000000-0000-0000-0000-000000000001";

it("cancels an unfinished connection handshake when the provider is disposed", async () => {
  let connectionSignal: AbortSignal | undefined;
  const provider = createFirefoxNativeTerminal({ bidiEndpoint: endpoint,
    connect: (_url, signal) => new Promise<FirefoxBidiClient>((_resolve, reject) => {
      connectionSignal = signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const pending = provider.browser!.tree();
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await provider.dispose();
  expect(connectionSignal?.aborted).toBe(true);
  await rejected;
});

function client(
  respond: (
    method: string,
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>,
) {
  let closed = false;
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>) =>
      respond(method, params),
  );
  const value: FirefoxBidiClient = {
    get closed() {
      return closed;
    },
    request,
    close() {
      closed = true;
    },
  };
  return {
    value,
    request,
    close: () => {
      closed = true;
    },
  };
}

function tree(context = "context-1") {
  return {
    contexts: [
      { context, url: "https://app.slack.com/client/T123/C123", parent: null },
    ],
  };
}

describe("Firefox native browser provider", () => {
  it.each([
    "https://127.0.0.1:9222/session",
    "ws://example.test/session",
    "ws://user@127.0.0.1:9222/session",
    "ws://127.0.0.1:9222/session/00000000-0000-0000-0000-000000000001?token=x",
  ])("rejects unsafe BiDi endpoint %s", (value) => {
    expect(() => firefoxBidiEndpoint(value)).toThrow(
      "local WebSocket endpoint",
    );
  });

  it("registers offline until a configured bridge is used, then connects lazily without owning its session", async () => {
    const bidi = client((method) =>
      method === "browsingContext.getTree" ? tree() : null,
    );
    const connect = vi.fn(async () => bidi.value);
    const provider = createFirefoxNativeTerminal({
      bidiEndpoint: endpoint,
      connect,
      startup: "test",
    });
    const identity = provider.sessionIdentity();
    expect(connect).not.toHaveBeenCalled();
    await expect(provider.listTabs()).resolves.toMatchObject({
      connected: true,
      tabs: [{ surfaceRef: "firefox:context-1", selected: true }],
    });
    expect(provider.sessionIdentity()).toBe(identity);
    expect(connect).toHaveBeenCalledWith(endpoint, expect.any(AbortSignal));
    await provider.dispose();
    expect(bidi.value.closed).toBe(true);
  });

  it("reports an empty endpoint unavailable without attempting a connection", async () => {
    const connect = vi.fn();
    const provider = createFirefoxNativeTerminal({
      connect: connect as never,
      startup: "test",
    });
    await expect(provider.listTabs()).resolves.toEqual({
      connected: false,
      tabs: [],
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("allows independent provider activations to attach to one operator-owned BiDi endpoint", async () => {
    const first = client((method) =>
      method === "browsingContext.getTree" ? tree("one") : null,
    );
    const second = client((method) =>
      method === "browsingContext.getTree" ? tree("two") : null,
    );
    const connect = vi.fn(async () =>
      connect.mock.calls.length === 1 ? first.value : second.value,
    );
    const selected = createFirefoxNativeTerminal({
      bidiEndpoint: endpoint,
      connect,
      startup: "selected",
    });
    const retained = createFirefoxNativeTerminal({
      bidiEndpoint: endpoint,
      connect,
      startup: "retained",
    });
    await expect(selected.listTabs()).resolves.toMatchObject({
      connected: true,
    });
    await expect(retained.listTabs()).resolves.toMatchObject({
      connected: true,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(
      (connect.mock.calls as unknown as Array<[string]>).map(([url]) => url),
    ).toEqual([endpoint, endpoint]);
    await selected.dispose();
    await retained.dispose();
  });

  it("uses one trusted pointer action without replaying a lost acknowledgement", async () => {
    const bidi = client((method) => {
      if (method === "browsingContext.getTree") return tree();
      if (method === "script.evaluate")
        return {
          type: "success",
          result: { type: "string", value: JSON.stringify({ x: 7, y: 9 }) },
        };
      if (method === "input.performActions")
        throw new Error("socket closed after click");
      throw new Error(`unexpected ${method}`);
    });
    const provider = createFirefoxNativeTerminal({
      bidiEndpoint: endpoint,
      connect: async () => bidi.value,
      startup: "test",
    });
    await provider.browser!.tree();
    const before = provider.sessionIdentity();
    await expect(
      provider.browser!.click({
        surface: "firefox:context-1",
        selector: '[data-qa="send"]',
      }),
    ).rejects.toThrow("socket closed after click");
    expect(
      bidi.request.mock.calls.filter(
        ([method]) => method === "input.performActions",
      ),
    ).toHaveLength(1);
    expect(provider.sessionIdentity()).not.toBe(before);
  });

  it("does not reconnect or click after the bridge closes between hit testing and the pointer action", async () => {
    const bidi = client((method) => {
      if (method === "browsingContext.getTree") return tree();
      if (method === "script.evaluate") {
        bidi.close();
        return {
          type: "success",
          result: { type: "string", value: JSON.stringify({ x: 7, y: 9 }) },
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    const connect = vi.fn(async () => bidi.value);
    const provider = createFirefoxNativeTerminal({
      bidiEndpoint: endpoint,
      connect,
      startup: "test",
    });
    await provider.browser!.tree();
    await expect(
      provider.browser!.click({
        surface: "firefox:context-1",
        selector: '[data-qa="send"]',
      }),
    ).rejects.toThrow("disconnected");
    expect(connect).toHaveBeenCalledOnce();
    expect(
      bidi.request.mock.calls.filter(
        ([method]) => method === "input.performActions",
      ),
    ).toHaveLength(0);
  });

  it("invalidates old contexts after malformed discovery", async () => {
    let valid = true;
    const bidi = client((method) =>
      method === "browsingContext.getTree"
        ? valid
          ? tree("one")
          : { contexts: [{ context: "two", url: "", parent: null }] }
        : null,
    );
    const provider = createFirefoxNativeTerminal({
      bidiEndpoint: endpoint,
      connect: async () => bidi.value,
      startup: "test",
    });
    await provider.browser!.tree();
    valid = false;
    await expect(provider.browser!.tree()).rejects.toThrow(
      "invalid background tab",
    );
    await expect(
      provider.browser!.focus({ surface: "firefox:one" }),
    ).rejects.toThrow("unknown");
  });
});

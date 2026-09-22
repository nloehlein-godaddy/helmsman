import { afterEach, describe, expect, it, vi } from "vitest";
import backend from "./backend";

afterEach(() => vi.unstubAllGlobals());

describe("Firefox native browser backend", () => {
  it("registers lazily without connecting to Firefox during activation", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const registerNativeTerminal = vi.fn();
    const onDispose = vi.fn();
    backend.activate({
      settings: { bidiEndpoint: "" },
      registerNativeTerminal,
      onDispose,
    } as never);
    expect(registerNativeTerminal).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

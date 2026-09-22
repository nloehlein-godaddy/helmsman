import { describe, expect, it } from "vitest";
import { builtinNativeTerminals } from "./builtin-terminals";

describe("builtin native terminals", () => {
  it("publishes separate cmux, Firefox, and WezTerm native-session packages", () => {
    expect(
      builtinNativeTerminals.map((entry) => entry.package.manifest.id),
    ).toEqual([
      "helmsman.terminal-cmux",
      "helmsman.native-firefox",
      "helmsman.terminal-wezterm",
    ]);
    const [cmux, firefox, wezterm] = builtinNativeTerminals.map(
      (entry) => entry.package.backend,
    );
    expect(cmux?.provides).toEqual([
      { id: "helmsman/native-terminal", version: 1, localId: "cmux" },
    ]);
    expect(cmux?.nativeTerminals).toEqual({
      cmux: { access: ["native-session"] },
    });
    expect(cmux?.settings).toMatchObject({
      binary: { default: "cmux" },
      socketPath: { default: "" },
    });
    expect(firefox?.provides).toEqual([
      { id: "helmsman/native-terminal", version: 1, localId: "firefox" },
    ]);
    expect(firefox?.nativeTerminals).toEqual({
      firefox: { access: ["native-session"] },
    });
    expect(firefox?.settings).toMatchObject({ bidiEndpoint: { default: "" } });
    expect(wezterm?.provides).toEqual([
      { id: "helmsman/native-terminal", version: 1, localId: "wezterm" },
    ]);
    expect(wezterm?.nativeTerminals).toEqual({
      wezterm: { access: ["native-session"] },
    });
    expect(wezterm?.settings).toMatchObject({
      binary: { default: "wezterm" },
      socketPath: { default: "" },
    });
  });
});

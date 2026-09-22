import type { NativeTerminalBackendModuleV1 } from "@helmsman/plugin-sdk";
import { createFirefoxNativeTerminal } from "./provider.js";

const module: NativeTerminalBackendModuleV1 = {
  activate(context) {
    const bidiEndpoint =
      typeof context.settings.bidiEndpoint === "string"
        ? context.settings.bidiEndpoint
        : "";
    const provider = createFirefoxNativeTerminal({ bidiEndpoint });
    context.registerNativeTerminal("firefox", provider);
    context.onDispose(() => provider.dispose());
  },
};

export default module;

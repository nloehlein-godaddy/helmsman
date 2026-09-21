# WezTerm native terminal

This backend-only package registers `helmsman.terminal-wezterm/wezterm` through `helmsman/native-terminal@1`. It provides terminal list, screen, text and key controls. It intentionally does not declare browser automation support.

The captured `binary` and `socketPath` settings determine every subprocess and native session identity. An empty socket path selects the newest live GUI socket from WezTerm's local runtime directory. Missing sockets fail closed and never start a headless mux server or select cmux.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

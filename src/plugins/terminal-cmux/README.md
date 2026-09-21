# cmux native terminal

This backend-only package registers `helmsman.terminal-cmux/cmux` through `helmsman/native-terminal@1`. It provides terminal list, screen, text and key controls plus the structured browser primitives used by authored communication providers.

The captured `binary` and `socketPath` settings determine every subprocess and native session identity. An empty socket path uses bounded local socket discovery. The package does not select another terminal when cmux is unavailable.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

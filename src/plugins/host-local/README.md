# Local execution hosts

This backend-only package registers `helmsman.host-local/detached`, `helmsman.host-local/cmux`, and `helmsman.host-local/wezterm` through `helmsman/execution-host@1`. Each provider retains the exact launch attempt, wrapper receipt, process identity, and native terminal reference. Missing or conflicting ownership evidence is reported as unknown and is never replaced by another provider.

The package settings `cmuxSocketPath`, `weztermBin`, and `weztermRunWorkspace` are captured with the retained provider binding. Build with `npm run build` after installing the released `@helmsman/plugin-sdk`, TypeScript and `@types/node`.

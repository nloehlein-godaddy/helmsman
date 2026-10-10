# cmux native terminal

This backend-only package registers `helmsman.terminal-cmux/cmux` through `helmsman/native-terminal@1`. It provides terminal list, screen, text and key controls plus the structured browser primitives used by authored communication providers.

The captured `binary` and `socketPath` settings determine every subprocess and native session identity. An empty socket path uses bounded local socket discovery. The package does not select another terminal when cmux is unavailable.

Tab prompt previews come from the newest live Codex or Claude session bound to that exact workspace and surface. Codex uses explicit user-message events or retained user input metadata; Claude uses its session-bound last prompt or typed user message. Reads scan backward in 2 MiB chunks, up to the final 64 MiB of a regular transcript file, and cache results in memory. Appended records are scanned incrementally when the cached file boundary is intact. Missing metadata, unsupported agents, unreadable transcripts, or prompts outside that bound leave the preview unavailable; terminal screen contents are never used to guess a prompt.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

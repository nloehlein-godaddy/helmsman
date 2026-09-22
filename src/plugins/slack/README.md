# Slack communication provider

This is the legacy browser transport. New Slack work defaults to the [Slack Companion provider](../slack-companion/README.md), which does not require a browser. This package remains available for explicitly selected browser integrations and retained delivery records.

This standalone provider implements `helmsman/communication` version 1 using only `@helmsman/plugin-sdk`. It receives a retained Slack workspace, channel, mention, connection, and bounded browser session. The host owns browser transport and credentials.

Run `npm run build` after installing the released SDK and TypeScript. The build copies the SDK runtime into `dist/sdk`, rewrites the SDK import, and leaves a package that can be packed independently.

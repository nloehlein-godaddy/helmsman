# Command agent provider

Registers `helmsman.agent-command/command` through the SDK-only `helmsman/agent` v1 backend capability. Set its `commandTemplate` plugin setting to a whitespace-delimited command that may use `{ticket}`, `{repo}`, and `{title}`. The setting must be nonsecret because admitted executions retain it. Legacy AGENT_CMD text is never copied automatically. An empty template does not select or invoke another agent.

This provider has no Docker transport, review delegation, or pre-PR workflow support. Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

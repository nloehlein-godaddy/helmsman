# Command agent provider

Registers `helmsman.agent-command/command` through the SDK-only `helmsman/agent` v1 backend capability. Set its `commandTemplate` plugin setting to a whitespace-delimited command that may use `{ticket}`, `{repo}`, and `{title}`. The setting must be nonsecret because admitted executions retain it. Legacy AGENT_CMD text is never copied automatically. An empty template does not select or invoke another agent.

This provider has no declared model transport, review delegation, or pre-PR workflow support. Mandatory GoCaaS routing blocks new launches through it; an authored replacement must declare a supported transport and honor the scoped endpoint and credentials. Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

# Claude Code agent provider

Registers `helmsman.agent-claude/claude-code` through the SDK-only `helmsman/agent` v1 backend capability. It consumes Claude stream JSON, including cumulative final costs and explicit failed result records.

Build with `npm install @helmsman/plugin-sdk typescript` and `npm run build`. The output contains the backend and package descriptor. Change the reserved manifest ID before installing a third-party copy.

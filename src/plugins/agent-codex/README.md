# Codex agent provider

Registers `helmsman.agent-codex/codex` through the SDK-only `helmsman/agent` v1 backend capability. It runs Codex JSON streaming mode, reports per-turn token and cost deltas, and declares the Codex review-agent skill for review delegation.

Build with `npm install @helmsman/plugin-sdk typescript` and `npm run build`. The output contains the backend and package descriptor. Change the reserved manifest ID before installing a third-party copy.

# Pull request review workflow

This backend-only package registers `helmsman.workflow-review/review` through `helmsman/workflow@1`. It renders the direct, pinned-revision adversarial review prompt and declares no staged execution policy.

The package receives only the public safe prompt projection. It cannot publish, mutate workflow state, inspect host runtime data, or select a different agent. Its `next` method is pure and unused for direct execution.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

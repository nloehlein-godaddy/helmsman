# Coding and branch workflows

This backend-only package registers `helmsman.workflow-coding/coding` and `helmsman.workflow-coding/branch` through `helmsman/workflow@1`. Coding uses guarded implement, independent review, fix, and publication stages. Branch updates render a direct same-branch prompt.

`maxRounds` and `stageTimeoutMinutes` are captured settings. Reviewer identities and count come from the retained agent selection. The pure `next` policy does not retain mutable state or perform execution, Git, publication, or network operations.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

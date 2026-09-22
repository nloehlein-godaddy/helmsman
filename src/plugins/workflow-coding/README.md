# Coding and branch workflows

This backend-only package registers `helmsman.workflow-coding/coding` and `helmsman.workflow-coding/branch` through `helmsman/workflow@1`. Coding uses guarded implement, independent review, fix, and publication stages. Branch updates render a direct same-branch prompt.

`maxRounds` and `stageTimeoutMinutes` are captured settings. Reviewer identities and count come from the retained agent selection. The pure `next` policy does not retain mutable state or perform execution, Git, publication, or network operations.

Reviewers target a customer-ready implementation within the ticket scope, not perfection. Scope expansion needs an explicit acceptance criterion or a concrete consequential regression, plus an explanation of why a smaller fix is insufficient. Credible rare edge cases belong in brief **Non-blocking** summary notes; they do not prevent approval or become fix-stage obligations. Blocking a rare case requires concrete evidence of a serious consequence or an explicit material acceptance failure. Only blocking defects belong in findings; a completed staged review with advisory notes uses `APPROVE` and `findings: []`.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

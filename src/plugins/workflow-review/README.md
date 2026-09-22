# Pull request review workflow

This backend-only package registers `helmsman.workflow-review/review` through `helmsman/workflow@1`. It renders the direct, pinned-revision adversarial review prompt and declares no staged execution policy.

The package receives only the public safe prompt projection. It cannot publish, mutate workflow state, inspect host runtime data, or select a different agent. Its `next` method is pure and unused for direct execution.

Reviewers target a customer-ready implementation within the ticket scope, not perfection. Scope expansion needs an explicit acceptance criterion or a concrete consequential regression, plus an explanation of why a smaller fix is insufficient. Credible rare edge cases belong in brief **Non-blocking** summary notes; they do not prevent approval or become fix-stage obligations. Blocking a rare case requires concrete evidence of a serious consequence or an explicit material acceptance failure. Only blocking defects belong in findings; a completed staged review with advisory notes uses `APPROVE` and `findings: []`.

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript.

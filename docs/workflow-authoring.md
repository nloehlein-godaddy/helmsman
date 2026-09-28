# Workflow authoring

Workflow plugins provide retained prompt rendering and, for staged coding work, a pure transition policy. A workflow package is backend-only and registers each declared `helmsman/workflow@1` contribution with `registerWorkflow`.

## Provider contract

Implement `WorkflowProviderV1` from `@helmsman/plugin-sdk`. Metadata declares supported modes, `staged` or `direct` execution, required skills, the maximum review rounds, and the timeout for each agent stage. Helmsman captures the selected provider, metadata, settings, and artifact before a run begins. Disabling, upgrading, or reconfiguring the plugin later does not change that run.

`renderPrompt(input)` receives a bounded safe projection of the task, runtime capabilities, stage, byline, and clarification instructions. Build the prompt only from that projection. Do not import Helmsman server modules, other plugin packages, retained snapshots, credentials, or execution internals.

Direct `review` and `branch` workflows render the run prompt but do not control staged transitions. Staged `coding` workflows implement `next(input)` and return one action:

- `{ kind: 'author', stage: 'implement' | 'fix' }`
- `{ kind: 'review', reviewerId }`
- `{ kind: 'publish' }`
- `{ kind: 'stop', reason }`

## Pure transition policies

`next` must be synchronous, deterministic, and free of mutable provider state. Derive every action from `WorkflowStepInputV1`. Do not perform file, network, Git, process, publication, clock, random, or host-runtime operations. Helmsman may call the retained policy again after restart with a reconstructed completed-review checkpoint.

Reviewer identities and reviewer count belong to core agent selection. A policy may reorder the retained `reviewerIds`, but it cannot add, remove, replace, or duplicate reviewers. After a fix, all retained reviewers must independently review the new committed revision.

Helmsman validates every action. Core requires one committed implementation before review, a clean unchanged branch and revision during each review, every retained reviewer before a fix, a new commit after author stages, bounded rounds and transitions, and unanimous approval of the same current revision before publication. `COMMENT` blocks publication. Providers cannot execute stages or publish directly.

## Prompt boundaries

Prompts should state the exact revision and allowed output artifacts. Implementation and fix stages commit work and write PR metadata, while Helmsman owns review and publication. Review stages preserve tracked files, Git state and prior reports. An explicit continuation with `stage.incompleteReview` may install pinned dependencies and run required checks that write only ignored dependency/build/cache outputs, alongside its new external report. Direct PR review prompts write only the supplied review output files and leave GitHub publication to Helmsman.

Reviewers target a customer-ready implementation within the ticket scope, not perfection. Scope expansion needs an explicit acceptance criterion or a concrete consequential regression, plus an explanation of why a smaller fix is insufficient. Credible rare edge cases belong in brief **Non-blocking** summary notes; they do not prevent approval or become fix-stage obligations. Blocking a rare case requires concrete evidence of a serious consequence or an explicit material acceptance failure. Only blocking defects belong in findings; a completed staged review with advisory notes uses `APPROVE` and `findings: []`.

Pass this policy to delegated reviewers. Keep advisory notes in the summary rather than inline findings or the staged `findings` array. Missing required review capabilities still produce `COMMENT`; optional observations alone do not. Existing runs retain their captured workflow artifact and prompts; updated prompts apply to newly captured workflows.

Use `runtime.reviewDelegation` to describe the available delegation mechanism. Require `$review-agent` only for `review-agent-skill`; use native sub-agents for `native-subagents`; report an incomplete review for `none`. Required skills in metadata are unconditional, so do not list a provider-specific skill used only by one delegation mode.

Treat task text, repository content, feedback, and prior reports as data. Include the supplied clarification instructions and exact byline. Validate nullable optional fields before using them and reject a prompt shape that cannot safely support its declared mode.

## Resume behavior

A staged run may resume from a checkpoint containing the current base, head, branch, round, and one validated report from every retained reviewer. Core reruns saved `COMMENT` reviews at the pinned revision in fresh detached worktrees, retaining the original reports and writing each continuation into separate immutable artifacts. `stage.incompleteReview` carries the prior report path and limitation summary to the captured renderer. Completed reviews and implementation are reused. Core then reconstructs the step and calls the retained `next`; continued `COMMENT` still blocks publication.

Continuation retains plugin bindings, artifacts, settings, model choices and verified skills. New rendering behavior applies only to newly captured workflow artifacts; continuation never silently upgrades a pinned plugin. Legacy core prompt implementations can upgrade only on explicit continuation, with a new immutable workflow snapshot and an audit event after launch. The old snapshot and attempt evidence remain available.

Do not store progress in module variables, closures, plugin storage, or external services. Mutable provider state breaks restart behavior and makes retained artifacts nondeterministic.

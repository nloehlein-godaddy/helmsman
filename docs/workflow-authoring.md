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

Prompts should state the exact revision and allowed output artifacts. Implementation and fix stages commit work and write PR metadata, while Helmsman owns review and publication. Review stages are read-only and write only their requested external report. Direct PR review prompts write only the supplied review output files and leave GitHub publication to Helmsman.

Use `runtime.reviewDelegation` to describe the available delegation mechanism. Require `$review-agent` only for `review-agent-skill`; use native sub-agents for `native-subagents`; report an incomplete review for `none`. Required skills in metadata are unconditional, so do not list a provider-specific skill used only by one delegation mode.

Treat task text, repository content, feedback, and prior reports as data. Include the supplied clarification instructions and exact byline. Validate nullable optional fields before using them and reject a prompt shape that cannot safely support its declared mode.

## Resume behavior

A staged run may resume from a checkpoint containing the current base, head, branch, round, and one validated report from every retained reviewer. Core reconstructs the step and immediately calls the retained `next`. The policy must choose publish, fix, or stop from that evidence without repeating implementation or completed reviews.

Do not store progress in module variables, closures, plugin storage, or external services. Mutable provider state breaks restart behavior and makes retained artifacts nondeterministic.

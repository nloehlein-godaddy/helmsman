# Remaining plugin delivery plan

Updated: 2026-09-21. Implementation has resumed at the user's request under the revised delivery approach. This document supersedes the testing frequency, review cadence and work sequencing in earlier implementation plans. The architecture's A–G scope and final acceptance requirements remain unchanged.

## What changes

The main delay has been repeated integration builds, overlapping reviews, and shipping intermediate contracts/compatibility layers without finishing the corresponding feature. The full unit suite currently takes about 3.4 minutes; its runtime alone does not explain Phase E's duration. Reduce repeated work and finish user-visible replacements sooner.

- Work toward one complete feature at a time: contract, implementation, package, route cutover and removal of its obsolete shell path. A service foundation alone is progress, not a completed extraction.
- Reuse the existing command journal, durable operation ledger, composition lifecycle and SDK patterns. Add a new abstraction only when the current feature cannot work correctly without it.
- Agree on the feature's public types and file ownership once. Backend and frontend owners then implement in parallel. Do not run three independent architecture reviews of every intermediate revision.
- Complete one independent review of the finished commit. Collect findings together, fix material issues, and review the corrective diff only. A reviewer may expand the review when a fix changes a shared invariant; stylistic preferences and speculative redesigns do not restart acceptance.
- Finish the current feature before opening another integration milestone. Record unrelated findings for the owning milestone; address them immediately only if they threaten data, request identity, authorization, recovery or the current feature's correctness.
- Update affected documentation and flows once the feature settles. Keep one concise milestone entry in the ledger instead of repeating the same validation narrative after every correction.

## Remaining delivery order

| Milestone | Concrete finish line | Dependencies and limits |
|---|---|---|
| Current E checkpoint — complete | Authored clarification alias, shared private PR session, catalog freshness and public PR inspection accepted, independently reviewed and pushed as `3806090`. | Final build, focused checks and six affected production scenarios passed. PR and Runs extraction remain open. |
| E run presentation and clarification recovery — complete | Runs/history/viewer use authored compositions and one shared viewer; legacy Runs rendering/history ownership is removed. Clarification recovery is independently buildable under the original caller. | Reviewed and pushed as `ab0757d`, `d61552f` and corrective `56e6d60`. The private PR panel remains explicitly tracked against the current PR/GitHub extraction. |
| E PR/GitHub extraction — complete | Deliver independently buildable PR presentation and replaceable GitHub integration through public contracts, including detail/diff, review actions and existing launch modes. Cut over PR routes and remove the private PR bridge. | Reviewed and pushed through `e6c3be3`; remote SHA verified. Public inspection, run commands and durable review operations preserve actor/head binding and remote uncertainty. |
| E Slack extraction — complete | Package Slack presentation/settings and replaceable communication policy; retain pinned destinations, durable requests and recovery through disable/restart. | Reviewed and pushed through `c16d3ff`; remote SHA verified. Authored communication and replaceable Slack preserve explicit retry, pinned destinations and retained receipts. |
| E terminal extraction — complete | Replace shell terminal ownership with an SDK-only composition/panel and scoped durable controls. | Reviewed and pushed through `9a36302`; remote SHA verified. Explicit inspection fences undelivered original commands. Native adapters remain assigned to F. |
| E campaigns — complete | Extract campaign presentation with public scoped reads and commands. Remove shell ownership while preserving dispatch gates. | Reviewed and pushed as `26359ae`; remote SHA verified. Existing campaign dispatch remains assigned to F. |
| E Local Git — complete | Extract branches/worktrees, cleanup preview and confirmed local operations into an independently buildable page/panel linked from Config. Remove shell rendering, state and handlers. | Reviewed and pushed through `631ad13`; remote SHA verified. Checkout validation, active-worktree protection, expected commits and uncertain-operation recovery remain in core. |
| E settings and inventory — complete | Move remaining optional feature settings/registrations into their owning packages. Audit every optional page/panel/integration against the original inventory and close gaps. | Reviewed and pushed through `85f1fe6`; remote SHA verified. The Phase E aggregate gate passed with focused corrections; see the completion ledger. Core plugin administration, runtime invariants and Recovery stay available. |
| F: execution extensions — active | Scheduling is complete through `dd98bf9`; agent extraction is implemented and awaiting validation. Complete validation, execution-host, workflow and remaining trigger contracts; retire deferred adapters only after proof. | Reuse Phase C admission, recovery, operations and publication safeguards. Agent selections retain immutable writer/reviewer order, settings and artifact closure across restart. |
| G: stabilization and removal | Remove remaining private-import exceptions and legacy switches; finish SDK templates/versioning/deprecation guidance. Verify an independent author can build frontend/backend replacements from the docs. Complete the repository-wide README/docs/flowchart audit. | Run final aggregate validation and check every original A–G deliverable. Compatibility bridges do not count as the final plugin architecture. |

These are exit criteria, not new architecture phases. Keep A–D closed unless a concrete regression reopens a specific requirement. No estimates or completion claims are inferred from the number of milestones.

### Remaining E ownership audit

The accepted dispositions are recorded in the [Phase E ownership inventory](plugin-phase-e-inventory.md). Aggregate acceptance, exact-commit review and correction review are complete. The table below records the ownership decisions made during that audit.

Local Git and integration settings have been extracted. Config remains a core administration surface, with links to independently available feature contributions.

| Remaining ownership | Required disposition |
|---|---|
| Jira bootstrap settings and token form in Config | Distinguish bootstrap defaults from existing source configuration; retire duplicate live controls without deleting saved overrides. Source fields belong to Jira/source settings. Credential storage and redacted access remain core; the Jira form is optional. |
| GitHub default galleon, PR author and review-watcher toggle | Move the forms to the integration's settings contribution with namespaced schemas, redacted reads and revision-checked writes. Watcher execution remains an explicit F adapter. |
| GitHub-backed shell greeting | Move optional profile lookup/presentation behind a public contribution; preserve a neutral core greeting when unavailable. |
| Feature navigation registration | Audit generic installed-page discovery and package-owned metadata. Static shipped defaults are allowed; optional feature branches in shell navigation need removal or an explicit G cleanup item. |
| Execution-related settings and triggers | Agent/custom command selection has moved to package configuration and `select-agent`/`select-agent-reviewers`; validation remains open. Pre-PR host/workflow, campaign dispatch, Slack/GitHub review launching and webhook workflow dispatch remain F. Track GitHub webhook parsing/configuration separately from core dispatch, including `HELMSMAN_WEBHOOK_SECRET`, `HELMSMAN_WEBHOOK_ROUTES` and `/api/webhooks/github`. |

Core retains galleon identity/scope, credentials, theme/terminology preferences, recovery, plugin administration, usage recording, budget/concurrency enforcement and publication safeguards. Presentation extraction cannot weaken these obligations. The explicit execution exceptions remain Phase F work.

## Validation cadence

| Point in the work | Required checks |
|---|---|
| During implementation | Use targeted tests to resolve a specific uncertainty or reproduce a bug. Do not run the full suite, production build or all browser scenarios after routine edits. Do not add tests that merely mirror implementation. |
| Feature ready for review/commit | Run TypeScript and the app build once for the settled source, plus affected unit/integration tests. Add or update meaningful regressions for changed behavior. Run the relevant browser flow for UI changes and inspect changed layouts; unchanged screens do not need new screenshots. |
| Public SDK, packaging or installed-runtime behavior changes | Build one distribution after source review settles. Use that same artifact for the affected source-denied installation/production scenarios. Compile a representative independent consumer for a new public contract. Reuse the existing general installation proof. |
| Review correction | Rerun the failing test and directly affected checks. Rebuild only artifacts affected by source changes. Broaden validation only when the correction changes a shared boundary or evidence identifies a wider risk. Do not automatically repeat the full suite and every production scenario. |
| Phase E and F completion | Run the full unit/integration suite, TypeScript/build, relevant browser suite and distribution checks once for the phase candidate. Reuse prior unchanged feature evidence; rerun scenarios covering shared behavior changed since that evidence. |
| Phase G completion | Run the complete final unit/integration, browser/visual and distribution acceptance, independent author proof, and repository-wide docs/link/flow audit. Verify the original requirements individually before declaring the goal complete. |

Changes to durable writes, request IDs, external publication, credentials, migrations, retained bindings or recovery still require focused failure/restart/uncertainty checks before acceptance. Reduced frequency does not mean accepting unverified side effects. Missing or failing required checks remain explicit in the ledger.

The exact build command already invokes `tsc`; do not separately repeat `tsc` immediately before or after a successful unchanged build. A running quiet test process is polled, not restarted. Record the artifact and checks used so unchanged work does not get rebuilt or retested by each agent.

## Agent and review workflow

1. Root defines the next feature's finish line and a short public-contract/file-ownership agreement. Use existing plans; do not commission another general architecture plan.
2. Assign independent backend and frontend/package work in parallel. Root handles integration and the minimal acceptance scenario. Use a third agent only for a separate useful task, not duplicate implementation.
3. Owners complete their implementation checks, report all known issues and stop editing. Integrate known fixes and build from stable sources; do not add a separate multi-agent precommit review or repeatedly announce stability before finishing the same audit.
4. Commit the complete feature. One independent Senior Software Architect reviews that exact commit. If a correction needs a new commit, review its changed behavior and immediate dependencies rather than restarting the entire review.
5. Push the reviewed feature using existing authorization and verify the remote SHA. Proceed to the next finish line. Do not accumulate unrelated incomplete features to fill agent slots.

## Preserved work at the stop

The last verified pushed commit is `91429669d5727776f84a84d8d90438e9c9d39a1c`. The current E increment remains uncommitted; retain its source, tests and documentation.

Existing evidence includes 23 passing browser tests, nine passing distribution checks, the public PR inspection production scenario, and private PR preservation production evidence. The earlier full unit run passed 4,545 of 4,546 tests; its sole descriptor-parity failure was fixed and its 14-test file passed afterward. Subsequent catalog/PR corrections require their affected checks; do not describe the earlier build as containing those fixes. The four clarification production scenarios still need final acceptance after the catalog freshness fix. No new commit or push is claimed.

The user has resumed implementation. The first checkpoint is delivered as `3806090`; clarification recovery is reviewed and pushed as `ab0757d`. Runs cutover and its one review correction are pushed as `56e6d60`; remote SHA verified. Public PR/GitHub extraction is accepted as `6ef2218` with correction `a230369`: focused build/production checks passed and correction-only architectural review is clean. The PR/GitHub push is verified at `e6c3be32ee562e10fbfaba1e5898067a89913ac2`. Slack extraction is reviewed and pushed through `c16d3ff1aced108c4a2b086ca87be8223fc3e03b`; remote SHA verified. Terminal extraction is reviewed and pushed through `9a363022499d40182fd37c3e32342ee3bb714049`; remote SHA verified. Campaign extraction is reviewed and pushed as `26359aec4162c98679630123323c5c8adf751ca2`; remote SHA verified. Local Git extraction is reviewed and pushed through `631ad13bace4fd3befd6fc64ddd7b03dccac1c89`; remote SHA verified. Jira/GitHub settings ownership is reviewed and pushed through `f83ef4557b130710ba3b98c099098800a572ab5a`; remote SHA verified. Profile ownership, navigation discovery and the Phase E exit are reviewed and pushed through `85f1fe6e3936a8f6452d18990154680d39efcf8f`; remote SHA verified. Phase F scheduling is complete through `dd98bf9`. Agent extraction is implemented but has not passed final validation or been accepted; execution hosts, workflows and remaining triggers remain open. Preserve the reduced review/testing cadence.

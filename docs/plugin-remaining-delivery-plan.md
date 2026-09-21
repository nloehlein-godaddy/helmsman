# Remaining plugin delivery plan

Updated: 2026-09-20. Implementation has resumed at the user's request under the revised delivery approach. This document supersedes the testing frequency, review cadence and work sequencing in earlier implementation plans. The architecture's A–G scope and final acceptance requirements remain unchanged.

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
| Finish E run presentation and clarification recovery | Make Runs/history/viewer routes use the authored composition with preserved selection, drafts, logs and pending identities. Move remaining clarification recovery presentation into a public-contract package under its original caller identity; preserve opaque legacy evidence. Remove obsolete shell branches. | The existing PR bridge may remain explicitly tracked until the immediately following PR milestone. Do not invent a general state-migration framework or bulk-import unknown data. |
| Finish E PR/GitHub extraction | Deliver independently buildable PR presentation and replaceable GitHub integration through public contracts, including detail/diff, review actions and existing launch modes. Cut over PR routes and remove the private PR bridge. | Reuse public inspection, run commands and durable manual-review operations. Preserve authenticated actor/head binding and remote uncertainty. Track optional Slack controls against the next milestone. |
| Finish E Slack extraction | Package Slack presentation/settings and replaceable communication policy; retain pinned destinations, durable requests and recovery through disable/restart. | Use the existing operation ledger and credential infrastructure. No new generic messaging framework or speculative transports. |
| Finish E workspace features | Extract terminal and campaigns as separate feature commits, with public scoped services and replaceable presentation. Remove their corresponding shell ownership. | Reuse current terminal/campaign coordination. Defer only the execution implementations explicitly assigned to F. |
| Finish E settings and inventory | Move remaining optional feature settings/registrations into their owning packages. Audit every optional page/panel/integration against the original inventory and close gaps. | Core plugin administration, runtime invariants and Recovery stay available. Run the Phase E aggregate acceptance once. |
| F: execution extensions | Complete agent, execution-host, workflow and scheduling contracts; extract their implementations and remove adapters deferred from E. Prove alternate implementations with retained bindings across restart. | Reuse Phase C admission, recovery, operations and publication safeguards. Implement one extension family at a time, sharing a contract harness where behavior overlaps. |
| G: stabilization and removal | Remove remaining private-import exceptions and legacy switches; finish SDK templates/versioning/deprecation guidance. Verify an independent author can build frontend/backend replacements from the docs. Complete the repository-wide README/docs/flowchart audit. | Run final aggregate validation and check every original A–G deliverable. Compatibility bridges do not count as the final plugin architecture. |

These are exit criteria, not new architecture phases. Keep A–D closed unless a concrete regression reopens a specific requirement. No estimates or completion claims are inferred from the number of milestones.

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

The user has resumed implementation. The first checkpoint is delivered as `3806090`; clarification recovery is reviewed and pushed as `ab0757d`. Runs cutover implementation and feature acceptance passed; exact-commit review and push are next, followed by public PR/GitHub extraction. Preserve the reduced review/testing cadence.

# Helmsman adversarial review — 2026-09-21

**Snapshot result: 12 confirmed findings — four P1 and eight P2.** The application builds and the tested UI flows work, but the current implementation should not be considered ready for unrestricted automation while the worktree deletion, stop, admission recovery, and request-protection defects remain open. No P0 was established.

This report records the review snapshot, not a fix release. At review completion, production source was unchanged and no review changes had been committed or pushed. The findings below include inherited defects as well as regressions introduced during the plugin rewrite.

Fix implementation and verification are tracked separately in the [fix ledger](adversarial-fixes-2026-09-21.md). This report preserves the original reviewed snapshot and evidence.

## Snapshot and review method

- Reviewed HEAD: `ec3dd6b544cba1f796c353134dc4af0437cf40a8`.
- Pre-plan baseline: `e471d86630d78f2285611e81256ff912e5f57d0e`.
- Review universe: 74 commits, 1,317 changed files, 97,907 insertions and 18,607 deletions, plus inherited code in the final application.
- Includes the two local commits after `0787a55`: native Node cmux cost refresh (`311185c`) and concurrent GitHub review-read failure handling (`ec3dd6b`). Both received specific review and passing checks.
- Environment: macOS arm64, Node `v24.17.0`, native ABI `137`.
- Six independent reviewers with different prompts, seven detached worktrees, one fresh distribution. Claude reviews used authenticated Claude CLI processes; they were not substituted with Codex agents. All six completed before this report was written.
- Root independently reproduced the browser request-protection failure, reran all four execution probes and both integration probe pairs, reproduced the lifecycle GC failure, and inspected UI screenshots/accessibility evidence.

The review covered every phase by ownership and risk area. It was not a line-by-line examination of every changed file or every intermediate commit. The reviewer reports describe their inspected paths, historical comparisons, test evidence, and gaps. Prior completion claims were treated as hypotheses rather than proof.

| Reviewer | Actual model / effort | Focus | Detailed report |
|---|---|---|---|
| Codex architecture | `gpt-6-astra` / high | SDK, packages, selection, activation/disposal, retention, compatibility, safe start, author distribution | [Architecture](adversarial-review-2026-09-21/reviewers/codex-architecture.md) |
| Codex execution | `gpt-6-astra` / high | Admission, attempts, leases, recovery, worktrees, processes, agents, hosts, workflows, scheduling/triggers | [Execution](adversarial-review-2026-09-21/reviewers/codex-execution.md) |
| Codex UI | `gpt-5.6-sol` / high | Real browser use, scope, drafts/receipts, layouts, plugin replacement, responsive presentation, accessibility | [UI](adversarial-review-2026-09-21/reviewers/codex-ui.md) |
| Claude security | `claude-opus-4-8` / high | HTTP authority, origin guards, credentials, gateways, filesystem and download boundaries | [Security](adversarial-review-2026-09-21/reviewers/claude-security.md) |
| Claude domain/data | `claude-sonnet-5` / high | Jira/Todos, identity, adoption, commands, scheduling, usage, pricing, outcomes | [Domain/data](adversarial-review-2026-09-21/reviewers/claude-sources.md) |
| Claude integrations | `claude-opus-4-8` / high | GitHub, Slack, remote effects, reconciliation, webhooks, clarification gates, cmux costs | [Integrations](adversarial-review-2026-09-21/reviewers/claude-integrations.md) |

P1 means a high-priority defect involving data loss, continued execution after Stop, durable loss of capacity, or unauthorized state changes. P2 means a material recovery, compatibility, resource-lifecycle, or accessibility defect. Lower-priority improvements and unproven concerns are listed separately and are not included in the 12 findings.

## Confirmed findings

| ID | Priority | Finding | Source review |
|---|---|---|---|
| R01 | P1 | PR rerun force-deletes a dirty developer worktree | CE-1 |
| R02 | P1 | Cross-origin requests can mutate unprotected loopback API routes | Security 1 + root browser proof |
| R03 | P1 | Known pre-launch checkout failure permanently reserves capacity | CE-2 |
| R04 | P1 | Detached Stop leaves ordinary descendants running after terminal receipt | CE-3 |
| R05 | P2 | Stop aborts the retained parser needed for finalization | CE-4 |
| R06 | P2 | GC deletes artifacts still referenced by pending lifecycle projections | ARCH-1 |
| R07 | P2 | Repeated retained external loads accumulate permanent ESM module instances | ARCH-2 |
| R08 | P2 | Safe start rejects valid non-Costs page bindings | ARCH-3 |
| R09 | P2 | Retained external loading bypasses the declared Node compatibility range | ARCH-4 |
| R10 | P2 | GitHub review reconciliation never follows the second review page | Integrations 1 |
| R11 | P2 | Repeated Helm layout controls lack distinguishing accessible names | UI 1 |
| R12 | P2 | Same-key runs have indistinguishable history buttons and viewer tabs | UI 2 |

### R01 — PR rerun deletes a dirty developer worktree

**Code:** [worktree.ts](../server/helmsman/worktree.ts#L26), especially lines 35, 51 and 75; runner/application call chain in CE-1.

A PR branch already checked out in an unlocked linked worktree is enough. `createWorktreeFromBranch` enumerates all worktrees and force-removes the one holding the branch, even outside Helmsman's `.worktrees` directory. Correct retained-head verification does not establish ownership of that checkout.

**Reproduced with real local Git:** a temporary developer worktree contained a modified tracked file and an untracked file. A stale expected head correctly rejected the rerun and preserved both. The correct expected head then deleted the developer worktree and created the new run checkout. This is inherited behavior retained through the rewrite, not a newly introduced deletion helper.

**Fix direction:** refuse an occupied branch or use an independent checkout strategy. Any deletion must go through explicit cleanup with ownership, dirty-state and active-execution checks. The Local Git page's protections currently do not cover this runner path.

[Evidence](adversarial-review-2026-09-21/evidence/codex_execution/dirty-worktree-rerun.json) · [Probe source](adversarial-review-2026-09-21/evidence/codex_execution/adversarial-execution.audit.test.ts.txt)

### R02 — Cross-origin requests mutate unprotected API routes

**Code:** [application.ts:1453](../server/helmsman/application.ts#L1453), [application.ts:1570](../server/helmsman/application.ts#L1570), [router.ts:426](../server/helmsman/router.ts#L426).

The same-origin/JSON guard protects an enumerated set of command prefixes. Other mutating routes bypass it, while `readBody` parses JSON regardless of content type. CORS blocking response reads does not by itself prevent a simple POST from taking effect.

**Root browser reproduction against the actual compiled server:** Chromium loaded a page from a different loopback origin and issued a `mode: 'no-cors'`, `Content-Type: text/plain` POST to `/api/repos/fixture%2Fproject/auto-claim`. Before the request, `autoClaim` was `[]`; afterward it contained `fixture/project`. The browser received an opaque response. A request with the same foreign origin/content type to the protected `/api/run-commands` route returned 403. All state was isolated and external commands were fake.

Static tracing also identifies unguarded launch, resume/retry/stop, Todo, and task-source mutation paths. **The demonstrated impact is unauthorized state mutation.** No real agent was launched and arbitrary code execution was not demonstrated. The security review's broader “any website”/RCE wording must be read with that limit: browser local-network policies can restrict public-site-to-loopback access; this probe demonstrated another loopback origin reaching the server. The server-side protection gap is real regardless of those additional browser defenses.

**Fix direction:** centralize default-deny protection for mutating methods before dispatch, with narrow explicit exceptions such as signature-verified webhook intake. Apply configured-galleon/input validation consistently as a separate check. Do not rely on callers supplying a particular content type voluntarily.

[Actual browser evidence](adversarial-review-2026-09-21/evidence/root/root-csrf-browser.log) · [Actual browser probe](adversarial-review-2026-09-21/evidence/root/review-csrf.ts.txt)

### R03 — A definite pre-launch failure permanently consumes capacity

**Code:** [runner.ts:707](../server/helmsman/runner.ts#L707), [runner.ts:758](../server/helmsman/runner.ts#L758), [runner-durability.ts:155](../server/helmsman/runner-durability.ts#L155).

The durable attempt and `started` admission are committed before worktree creation. If creation fails, the attempt remains `prepared` with no worktree path. Attachment recovery rejects that missing path without retrying preparation. Cancellation rejects an existing attempt; reservation release requires outcome evidence; normal Retry requires a failed run.

**Reproduced:** the real stores/coordinator were closed and reopened after an injected checkout failure. The repaired checkout callback was never called again. Three attachment retries remained blocked, cancellation/release rejected, and a new admission in a different galleon failed at concurrency 1. The worker launch callback was called zero times. No supported recovery action resolved this state. This is distinct from intentionally preserving uncertainty after a possible launch or for legacy records with missing provenance.

**Fix direction:** distinguish proven pre-launch states from launch uncertainty. Add fenced retry or audited cancellation, with source-claim settlement and pin/reservation release. Persist workspace intent so interrupted creation can be reconciled without guessing ownership.

[Evidence](adversarial-review-2026-09-21/evidence/codex_execution/preparation-failure-restart.json)

### R04 — Detached Stop can finish before descendants stop

**Code:** [host-local/provider.ts:168](../src/plugins/host-local/provider.ts#L168), [run-wrapper.mjs:40](../server/helmsman/run-wrapper.mjs#L40).

The extracted detached host signals only the verified wrapper PID. The wrapper signals only its immediate child and writes terminal evidence when that child exits. An ordinary descendant can remain alive. The old detached implementation attempted to signal the owned process group.

**Reproduced:** the actual provider's `stop` operated on a test-owned real wrapper and ordinary Node subprocess tree. The descendant neither detached nor ignored signals. A valid exit receipt existed before the descendant wrote a file 750 ms later. It then self-exited. This affects direct execution paths; the separately supervised staged pre-PR path has additional group cleanup and was not shown to have this defect.

**Fix direction:** supervise a dedicated owned process tree/group and settle it before releasing resources. Retain process-identity checks; do not signal unrelated terminal processes or an unverified PID/group.

[Evidence](adversarial-review-2026-09-21/evidence/codex_execution/descendant-after-stop.json)

### R05 — Stop invalidates the parser required to finalize the stopped run

**Code:** [application.ts:1180](../server/helmsman/application.ts#L1180), [agent-retained-loader.ts:113](../server/helmsman/agent-retained-loader.ts#L113), [runner.ts:645](../server/helmsman/runner.ts#L645).

The retained agent inherits the admission cancellation signal. Stop aborts that signal while the same provider is still needed to parse final stdout. A final line therefore throws an abort error before the matching exit receipt becomes a recorded outcome.

**Reproduced:** an installed inert external agent, the actual retained loader/adapter, and real durable runner produced `running`, blocked attachment, no outcome, and a retained reservation despite stopped-worker evidence. Reloading the **same** retained provider under a fresh recovery lifetime drained the log, reached `stopped`, and released capacity. Unlike R03, this has a supported recovery path.

**Fix direction:** separate admission cancellation from the retained parsing/observation lifetime required for settlement. Check host discovery for the same lifetime coupling.

[Before/after recovery evidence](adversarial-review-2026-09-21/evidence/codex_execution/stop-aborts-parser.json)

### R06 — GC removes an artifact needed by unfinished projection recovery

**Code:** [plugins/lifecycle.ts:244](../server/helmsman/plugins/lifecycle.ts#L244), [plugins/store.ts:356](../server/helmsman/plugins/store.ts#L356).

Collection checks current selection and execution pins, but not pending persistence intents. An unresolved projection write can leave an old intent referencing v1 after lifecycle/catalog selection has advanced to v2. Collecting v1 succeeds; later replay requires the deleted archive and fails permanently with `ENOENT`.

**Reproduced through the compiled CLI:** inject a plugin-data projection failure, disable v1, install v2, collect v1, then remove the original fault. Enabling/reconciling v2 still fails. Restoring only v1's original archive bytes repairs it. Root also reproduced the independent crash-hook variant. This requires an incomplete projection across replacement/collection; normal settled GC was not shown to fail.

**Fix direction:** make unfinished projection references part of collection eligibility under the same transaction, or safely settle/supersede those intents first.

[CLI evidence](adversarial-review-2026-09-21/evidence/codex_architecture/lifecycle-gc-cli.log) · [CLI probe](adversarial-review-2026-09-21/evidence/codex_architecture/lifecycle-gc-cli.mjs.txt)

### R07 — Retained loading leaks distinct ESM module instances

**Code:** [plugins/materialize.ts:9](../server/helmsman/plugins/materialize.ts#L9), [native-terminal-retained-loader.ts:80](../server/helmsman/native-terminal-retained-loader.ts#L80); shared materialization also serves agent/host/workflow loading.

Each load extracts into a fresh random directory, creating a new module URL. Node retains those ESM identities after the provider is disposed and files are removed. Communication delivery/reconciliation creates such retained sessions repeatedly in the long-running server.

**Reproduced:** 64 loads/disposals of the same external provider with a 1 MiB immutable module-level lookup table left about 64 MiB of additional array-buffer memory after forced GC, with an empty runtime directory. This demonstrates unbounded accumulation, not a measured production OOM threshold.

**Fix direction:** use stable immutable artifact URLs with separate activation lifetimes, or a genuinely unloadable execution boundary. File cleanup alone cannot unload Node's module map.

[Memory/evaluation evidence](adversarial-review-2026-09-21/evidence/codex_architecture/retained-loader.log) · [Probe](adversarial-review-2026-09-21/evidence/codex_architecture/retained-loader.mjs.txt)

### R08 — Safe start misclassifies supported page bindings as corrupt

**Code:** [safe-start.ts:75](../server/helmsman/safe-start.ts#L75).

Safe-start metadata validation still accepts only the Costs slot. A valid persisted Helm, Todos, Runs or other non-Costs binding makes the entire installed-plugin metadata read fail.

**Reproduced through HTTP:** a Costs-only control exposed the installed plugin. Adding a valid built-in Helm binding produced `plugins: []`, empty returned bindings, and a generic metadata-read error. Normal reads confirmed all stored data remained intact. **This hides recovery diagnostics; it does not delete the installation.**

**Fix direction:** share current slot validation while keeping safe start read-only and free of provider execution.

[Evidence](adversarial-review-2026-09-21/evidence/codex_architecture/safe-start-catalog.log)

### R09 — Retained external providers can execute outside their Node range

**Code:** [native-terminal-retained-loader.ts:41](../server/helmsman/native-terminal-retained-loader.ts#L41), line 80, and analogous retained agent/host/workflow loading; contrast [plugins/backend.ts:274](../server/helmsman/plugins/backend.ts#L274).

Ordinary activation checks the package's Node range. Retained external loading verifies descriptor shape, hashes and other identity data, then imports without that range check.

**Reproduced on Node 24:** a staged retained artifact declaring Node 23 only was rejected by ordinary activation before evaluation, but the retained browser loader evaluated and invoked it. The fixture represents pre-existing retained storage after an upgrade; normal installation was not shown to accept an incompatible artifact. Built-in retained runtimes have a separate ABI/major check, so the exposed case is an external-only retained closure, including replaceable communication/browser providers.

**Fix direction:** apply compatibility checks before evaluating retained external code and surface a blocked recovery reason for unsupported runtimes.

[Control and failing-path evidence](adversarial-review-2026-09-21/evidence/codex_architecture/retained-loader.log)

### R10 — GitHub reconciliation cannot discover a later-page review receipt

**Code:** [github/provider.ts:281](../src/plugins/github/provider.ts#L281), particularly line 284. The retained legacy path at [operation-github.ts:62](../server/helmsman/operation-github.ts#L62) paginates.

After remote success with local acknowledgment loss, the extracted provider checks only `page=1&per_page=100`. It ignores a next-page link, so a matching receipt on a later page cannot be found and the operation stays uncertain.

**Reproduced with mocked HTTP, independently rerun by root:** a full first page with `rel="next"` returned unknown without following pagination. The exact matching marker on page 1 was acknowledged in the control. No live review was posted. The durable ledger preserved no-replay protection; **no automatic duplicate publication was demonstrated.**

**Fix direction:** bounded pagination with exact actor/head/body-marker matching and duplicate detection. Preserve unknown on incomplete coverage; do not infer non-application from absence in a partial history.

[Probe](adversarial-review-2026-09-21/evidence/claude_integrations/reconcile-pagination-probe.test.ts.txt) · [Independent rerun](adversarial-review-2026-09-21/evidence/root/root-integrations-confirmation.log)

### R11 — Helm's repeated layout controls are ambiguous to assistive technology

**Code:** [helm/page.ts:125](../src/plugins/helm/page.ts#L125), through line 157.

The actual accessibility tree exposes eight default “Remove” buttons, eight “Duplicate” buttons and other repeated generic names. Their sibling panel titles do not label the buttons or a named group. Removal immediately persists layout changes and discards that instance's opaque state.

**Reproduced in Chromium:** visible panel rows and accessibility snapshots confirm the missing context. Each button was wired to the correct instance; no wrong-target execution was observed. The defect is inability to distinguish commands reliably through assistive/voice control.

**Fix direction:** give controls or their groups distinguishable panel/instance context. Include an instance distinction when the same panel is duplicated; its title alone is insufficient.

[Accessibility tree](adversarial-review-2026-09-21/evidence/codex_ui/helm-manager-accessibility.txt) · [Screenshot](adversarial-review-2026-09-21/evidence/codex_ui/helm-manager-ambiguous-controls.png)

### R12 — Same-key runs are indistinguishable in history controls and open tabs

**Code:** [run-history/panel.ts:93](../src/plugins/run-history/panel.ts#L93), [run-viewer/panel.ts:289](../src/plugins/run-viewer/panel.ts#L289).

Two runs with the same display key in different galleons produce identical history-button names and viewer-tab labels. Identity exists in adjacent selected-run content, but not in the tab choices. The tab `title` was not exposed as a distinguishing name or description in the captured tree.

**Reproduced:** `org/a` and `org/b` each had a `TASK-1` run with distinct logs. Both opened correctly, but both tabs were named `TASK-1`. No wrong-run binding was observed. Choosing the intended run remains ambiguous before applying its controls.

**Fix direction:** include galleon and a short canonical run/attempt identity in visible and accessible choices.

[Accessibility tree](adversarial-review-2026-09-21/evidence/codex_ui/duplicate-run-accessibility.txt) · [Screenshot](adversarial-review-2026-09-21/evidence/codex_ui/duplicate-run-identities.png)

## Validation and counterevidence

| Check | Actual outcome |
|---|---|
| Fresh `npm run build:distribution` | Passed; includes TypeScript, frontend production build and runnable distribution |
| Full `npm test -- --maxWorkers=4` | 4,832 passed, one failed, 365 files; failure was a shared-dependency-path assumption in the review worktree |
| That failing file in the original checkout | All 23 tests passed; no source fix was made. Symlinked `node_modules` resolved `tsx` outside the detached worktree, defeating its expected retained-path assertion |
| `node --test scripts/distribution-check.mjs` | 9/9 passed, including source-denied CLI/SDK, document links, source adoption/restart and safe distribution replacement |
| Execution reviewer | 84 existing tests passed; 4 adversarial observation probes passed; root independently reran all four |
| Architecture reviewer | Six probe/verification commands passed, including 13 archive/import controls and an independent SDK-only page/panel compile→pack→install→enable proof |
| UI reviewer | 5 actual Chromium production-distribution scenarios passed, plus screenshots and accessibility snapshots |
| Domain/data reviewer | Final sets: 277 + 47 existing tests and 11 new probes passed; earlier overlapping runs are not added to this total |
| Integration reviewer | 9 GitHub provider tests, 48 effect/ledger tests and 4 new probe assertions passed; root independently reran the four probes |
| Root security proof | Actual cross-origin browser mutation reproduced; protected command route rejected the equivalent foreign-origin request |

Passing adversarial **observation** probes mean the stated defective behavior was reproduced, not that it was fixed. Some initial review-test iterations failed because the probe itself had a wrong expectation or locator; those were corrected and are not counted as product defects. The baseline result is reported as observed, not rewritten as an entirely green full-suite run.

The UI inventory exercised Helm, PRs, Triage, Todos, Terminal, Bugs, Runs, Costs, Campaigns, Agent questions, Config, Communication, Local Git, Jira/GitHub/Source settings, and standalone Recovery. Tests waited for boot removal and visible nonempty content. Representative 390×844 views showed no document overflow. Tested behavior included keyboard navigation, explicit missing-page handling, a separately built Costs replacement, scope changes, reload, two-tab layout convergence, and lost-response Todo receipt reconciliation.

The Todo mutation kept one backend task with the originally submitted content and preserved a newer unsent draft across scope/plugin changes. No duplicate command, stale cross-scope paint, wrong-run binding, silent built-in fallback, or restoration of deliberately removed layout entries was reproduced.

The domain/data lane found **no confirmed correctness defect**. New probes and existing focused tests held for source identity collisions, stale/duplicate/non-advancing cursors, collection drift, transaction rollback and receipt recovery, exact request-ID reuse, partial cost coverage, non-midnight date windows, PR deduplication and distinct-PR cost denominators. That is bounded positive evidence, not a guarantee about all real provider responses.

## Phase coverage and acceptance implications

| Phase | Reviewed boundary | Main result |
|---|---|---|
| A | Manifests, routes/slots, loader, SDK, safe start, production distribution | Package rejection/independent author checks pass; R08 exposes an old Costs-only assumption |
| B | Public usage/pricing, Costs replacement, backend activation/storage | Data/financial probes and live replacement pass; no confirmed accounting defect |
| C | Durable admissions, projections, pins, recovery, external effects | R03, R05 and R06 reopen concrete recovery obligations |
| D | Coexisting sources, neutral identity, adoption, claims and command receipts | No confirmed domain defect in the reviewed paths; negative probes pass |
| E | Helm/panels/pages, scope/layout, task editors, PR/Slack/terminal/campaign/settings surfaces | Stateful UI works; R10–R12 remain, with R02 crossing legacy/new route boundaries |
| F | Agents, hosts, workflows, scheduling/triggers and retained execution | R04, R05, R07 and R09 expose lifecycle/execution gaps |
| G | SDK author/distribution, compatibility, retirement/parity, documentation | Independent author and documentation checks pass; R01/R02 show inherited paths still need protection and R10 shows extracted-provider parity loss |

## Improvements and unresolved concerns — not additional confirmed defects

| Item | Evidence and next step |
|---|---|
| GitHub secondary-rate-limit recovery | Mocked 403 is definitely-not-applied/non-retryable while 429 is retryable. Treat documented rate-limit signals as retryable with appropriate delay; distinguish them from permission failures. Do not turn an uncertain send into a blind retry. This is low-priority resilience work, not duplicate-publication evidence |
| Slack lost-ack reconciliation | The browser-backed provider deliberately returns unknown without an exact durable receipt. Keep that safety policy until an authoritative request/destination/connection-bound lookup exists; a similar URL or message is insufficient |
| cmux lock ownership | Static concern: a numeric PID lock can outlive its owner and look live after PID reuse. Prefer verified process-start/owner identity and bounded locking; an mtime-only deletion could steal a legitimate long-running lock |
| Galleon checkout basename collisions | Static concern: runner helpers map `owner-a/repo` and `owner-b/repo` to the same basename; Local Git has stronger origin/collision checks. Prove or disprove the direct-workflow path before assigning severity; staged pre-PR remote checks limit some cases |
| Retry/checkpoint lifecycle | Follow up on recovered failed direct attempts versus the initial automatic-retry loop, and retention of checkpoints older than the immediate predecessor. Explicit retirement exists; no additional defect was reproduced |
| Gateway exposure and input consistency | Consider narrowing Docker gateway interface exposure while preserving required reachability. Tokens/active-run checks remain enforced. Align legacy run-ID and configured-galleon validation across routes |
| Domain helper hardening | `aggregateOutcomes` accepts duplicate run IDs with last-write-wins; actual database callers supply unique IDs. Document the contract or reject conflicting duplicates if broader callers are added. Avoid optimizing bounded Todo history sorting without evidence it matters |
| Mobile Recovery readability | The plugin lifecycle table fits but wraps heavily at 390px. A minimum width with contained horizontal scrolling would improve scanning |
| Initial frontend size | The build reports an approximately 966 kB minified / 230 kB gzip entry chunk. Measure startup cost and consider lazy loading optional shipped presentations; no performance regression was measured here |
| Focused regression gates | Promote the proven preparation/Stop/GC/request-origin cases into maintained tests when fixed. Add route-guard inventory checks and shared retained-loader compatibility tests to prevent duplicated boundaries drifting again |

Recommended fix order: R01–R04 first; then R05–R10 in coherent ownership/lifecycle changes; address R11–R12 with the relevant presentation packages. Use the existing reduced validation cadence: reproduce each defect, fix it, run affected checks, then perform one aggregate gate on the settled candidate. Repeated full builds after every edit are unnecessary.

## Limits and evidence

No live GitHub/Jira/Slack messages, real model jobs, real Docker engine execution, or user terminal actions were performed. Real process/Git tests used disposable local fixtures and owned child handles. UI testing used Chromium; Linux/Windows runtime behavior and other browsers were not exercised. Public-site local-network browser policies were not exhaustively tested. Large histories, filesystem power loss, every migration schema, and every possible provider interleaving were not exhaustively explored. Trusted plugin code execution is an explicit design boundary and was not mislabeled as a sandbox escape.

The original demo and user's separate application were left untouched. Review fixtures used isolated state and ephemeral ports.

The [evidence bundle guide](adversarial-review-2026-09-21/README.md) links the six complete reviews, captured logs, probes, screenshots, and replay notes. It preserves the review snapshot and [runtime/model completion metadata](adversarial-review-2026-09-21/metadata.json). The consolidated classifications and qualifications here take precedence over stronger wording or speculative recommendations in an individual raw review.

_Helmsman · not reported - not reported_

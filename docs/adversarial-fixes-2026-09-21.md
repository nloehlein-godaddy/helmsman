# Adversarial review fixes — 2026-09-21

This ledger resolves the 12 confirmed findings in the [six-agent adversarial review](adversarial-review-2026-09-21.md). It covers implementation and verification after baseline `ec3dd6b544cba1f796c353134dc4af0437cf40a8`; the original report and evidence remain historical. Secondary improvement ideas remain in that report.

Work was split across independent execution, workspace/process, plugin-lifecycle and browser-regression worktrees. Commits were cherry-picked onto `fix/adversarial-review-2026-09-21`. No branch was merged into master, and the user's demo was not restarted.

**Status: all 12 confirmed findings implemented and verified.** Each implementation commit received architectural review; execution/process and lifecycle changes also received independent cross-review. The final review found no remaining material blocker.

## Disposition

| Finding | Fix | Integrated commits | Regression coverage |
|---|---|---|---|
| R01 | Refuse occupied PR branches; never implicitly delete or prune another checkout. | `2b03972` | Real Git dirty tracked/untracked files, stale head and clean occupied checkout. |
| R02 | Guard every non-read HTTP method before body parsing and dispatch; retain exact signature-verified webhook exemption. Legacy bodyless clients send JSON headers; Vite preserves browser Host. | `8dcdb6a` | Origin/Host/method matrix and installed Chromium cross-origin attack, same-origin requests and webhook signature rejection. |
| R03 | Lease-fenced settlement for proven never-launched failure; uncertain launches and unresolved claims keep recovery protections. | `50b588f`, `f262636`, `47355a0` | Checkout failure, database restart, capacity release, immutable outcome and claim uncertainty. |
| R04 | Dedicated POSIX supervisor owns ordinary descendants; terminal receipt waits for cleanup and staged coordinator evidence. | `2b03972`, `e663b07`, `c7f85c8` | Real detached and emulated terminal trees, natural exit, TERM resistance, wrong identity, wrapper/supervisor/coordinator crashes. |
| R05 | Separate admission cancellation from retained parser/host observation lifetime. | `50b588f` | Actual retained provider, Stop followed by final output drain, disposal and restart paths. |
| R06 | Pending plugin projections block collection of their artifact hashes. | `228b7e6` | Persistent SQLite projection failure followed by GC/reconciliation. |
| R07 | Stable process-scoped ESM URL per root/artifact; serialized materialization and reference-counted files. | `228b7e6` | Concurrent leases, lazy imports, old/new hash isolation, one evaluation across repeated independent activations. |
| R08 | Safe start validates all supported page slots using shared slot metadata. | `228b7e6` | Every supported slot through read-only safe-start HTTP; unknown bindings rejected. |
| R09 | Validate Node compatibility across the entire retained external closure before evaluation. | `228b7e6` | Native terminal/browser, agent, execution-host and workflow loaders, including incompatible dependency closures. |
| R10 | Read bounded review pagination and require complete, unambiguous actor/head/body evidence; recheck actor/head afterward. | `8dcdb6a` | Second-page receipt, repeated/malformed/foreign/failed pages, 20-page bound, cancellation and changed actor/head. |
| R11 | Identify Helm groups/actions and stack destinations by full panel instance identity. | `8dcdb6a`, `875ae2a` | Duplicated panels, shared-prefix IDs, correct targeted removal and installed browser controls. |
| R12 | Identify history choices and viewer tabs by galleon/run identity, with attempt in accessible names. | `8dcdb6a`, `875ae2a` | Same-key runs across and within galleons, canonical selection, wrapping tab labels and installed desktop/mobile views. |

## Review corrections

Post-commit review hardened immutable never-launched outcomes and removed competing cleanup deadlines for staged workers. Independent cross-review then reproduced a numeric coordinator crash that still fabricated stage settlement; explicit cleanup acknowledgement replaces inference from numeric exit status. The aggregate unit gate exposed legacy Jira claim uncertainty being settled too early; that recovery behavior is preserved rather than changing the test expectation. UI review also found truncated stack-option identities and visually clipped run-tab identities; both require complete distinguishing labels.

## Verification

- Final full unit suite: **4,922 tests passed across 370 files** ([log](adversarial-fixes-2026-09-21/evidence/final-unit.log)). The earlier legacy-claim regression was corrected and the entire suite rerun.
- TypeScript, Vite and distribution build passed ([build log](adversarial-fixes-2026-09-21/evidence/final-build.log)); all **nine distribution checks passed** ([log](adversarial-fixes-2026-09-21/evidence/final-distribution-check.log)).
- Thirteen installed scenarios passed in the first integrated gate ([log](adversarial-fixes-2026-09-21/evidence/distribution-ui.log)), covering replacement, safe start, recovery, retained agents, inspection and presentation.
- The final distribution passed both new adversarial browser cases, run presentation and retained workflow/publication ([log](adversarial-fixes-2026-09-21/evidence/final-distribution-ui.log)). The installed-host test needed JSON headers on its bodyless Stop requests and teardown that waits for its verified wrapper; its corrected rerun is recorded below.
- Both browser composition scenarios passed ([log](adversarial-fixes-2026-09-21/evidence/final-browser.log)). An isolated actual Vite/Chromium check confirmed Host preservation and rejection through the development proxy ([evidence](adversarial-fixes-2026-09-21/evidence/browser-regressions-dev-proxy.log), [probe](adversarial-fixes-2026-09-21/evidence/browser-regressions-dev-proxy.ts.txt)).
- Inspected duplicate-panel, long/shared-prefix run-tab and offline-flow screenshots on desktop/mobile. No page overflow or clipped run identity was observed ([desktop](adversarial-fixes-2026-09-21/evidence/same-key-run-tabs-desktop.png), [mobile](adversarial-fixes-2026-09-21/evidence/same-key-run-tabs-mobile.png)). Affected documentation links resolve; original audit evidence hashes are unchanged.

The installed-host correction (`eb27c67`) passed in the canonical checkout against the final release: retained provider discovery, disablement, restart, Stop and immutable snapshots ([rerun log](adversarial-fixes-2026-09-21/evidence/final-execution-host.log)). The temporary-worktree attempt used a symlinked release and was excluded from acceptance. Final TypeScript and source/documentation whitespace checks passed; verbatim evidence logs retain their original formatting. No production code changed after the final full unit/build gate.

All process, Git, database and browser scenarios use disposable fixtures and owned process handles. cmux, WezTerm and external integrations are fixture-emulated; these checks do not claim live provider or native terminal acceptance.

## Operational limits

- Local worker-tree supervision uses POSIX process groups on macOS/Linux. New Windows local launches fail closed pending a Job Object implementation; existing receipts remain inspectable. Real process tests ran on macOS.
- Deliberately daemonized descendants that leave the owned process group require separate supervision. Unproven staged cleanup retains ownership and capacity.
- Node retains evaluated modules, including failed or pending top-level evaluation, until process restart. Repeated activation of the same immutable artifact no longer creates distinct module identities; plugin mutable state belongs to each activation.
- GitHub reconciliation scans at most 20 pages of 100 reviews. Incomplete or ambiguous history remains unknown and never authorizes another publish.
- Known failed preparation does not authorize deletion of a partial checkout. A normal Retry creates a fresh run; uncertain source ownership keeps its independent pins. Unresolved legacy pre-launch claims also retain execution capacity until reconciliation.

_Helmsman · not reported - not reported_

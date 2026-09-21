# Review evidence bundle

Read the [consolidated review](../adversarial-review-2026-09-21.md) first. It adjudicates severity, reproduction strength and limitations across the six independent reports.

## Independent reports

- [Codex architecture](reviewers/codex-architecture.md)
- [Codex execution](reviewers/codex-execution.md)
- [Codex UI](reviewers/codex-ui.md)
- [Claude security](reviewers/claude-security.md)
- [Claude domain/data](reviewers/claude-sources.md)
- [Claude integrations](reviewers/claude-integrations.md)

These are the original reviewer outputs. Recorded absolute paths refer to the isolated review workspace, not the user's running application. See the consolidated report for corrections to the security review's broader RCE/website wording and for the distinction between confirmed defects and improvements.

## Baseline and independent verification

- [Fresh TypeScript/build/distribution log](evidence/root/current-build.log)
- [Full unit-suite log](evidence/root/baseline-unit.log)
- [Dependency-path failure rerun in the original checkout](evidence/root/runtime-paths-native-checkout.log)
- [Nine distribution checks](evidence/root/distribution-check.log)
- [Actual browser cross-origin proof](evidence/root/root-csrf-browser.log)
- [Root execution reproduction rerun](evidence/root/root-execution-confirmation.log)
- [Root integration reproduction rerun](evidence/root/root-integrations-confirmation.log)
- [Root GC reproduction](evidence/root/root-gc-confirmation.log)
- [Claude domain test output](evidence/root/claude_sources-test-evidence.log)
- [Claude integration test output](evidence/root/claude_integrations-test-evidence.log)
- [Phase history inventory](evidence/root/phase-history.txt)
- [Snapshot and actual reviewer-model/completion metadata](metadata.json)

## Probe sources and visual evidence

`evidence/` contains each lane's saved small probes, observations and logs. Script/test sources have an additional `.txt` suffix so the normal test runner does not accidentally collect defect-demonstration probes as production tests. These tests intentionally assert several currently defective behaviors.

- [Execution probes](evidence/codex_execution/adversarial-execution.audit.test.ts.txt)
- [Browser request-protection probe](evidence/root/review-csrf.ts.txt)
- [GitHub reconciliation/rate-limit probes](evidence/claude_integrations/reconcile-pagination-probe.test.ts.txt)
- [UI production-distribution probes](evidence/codex_ui/codex-ui-adversarial.pw.ts.txt)
- [Todos probes](evidence/claude_sources/todos-adversarial-probe.test.ts.txt)
- [Outcomes probes](evidence/claude_sources/outcomes-adversarial-probe.test.ts.txt)
- [Shell screenshot](evidence/codex_ui/shell-desktop.png)
- [Lost-response Todo screenshot](evidence/codex_ui/todo-reconciled-newer-draft.png)
- [Mobile Recovery screenshot](evidence/codex_ui/recovery-mobile.png)
- [Panel-control accessibility tree](evidence/codex_ui/helm-manager-accessibility.txt)
- [Run-choice accessibility tree](evidence/codex_ui/duplicate-run-accessibility.txt)

The six architecture scripts and matching logs are in `evidence/codex_architecture/`: lifecycle GC via CLI and crash hook, retained-loader compatibility/memory, safe-start catalog, 13 validation controls, and independent SDK author build/install.

## Replaying the exact snapshot

The original review workspace is `/private/tmp/helmsman-adversarial-20260921-ec3dd6b`, with a fresh immutable artifact at `integration/release`. Exact commands appear in the individual reports and remain usable while that workspace exists. Full Playwright traces are retained under its `probes/codex_ui/` directory; approximately 40 MiB of trace archives were not copied into the galleon. Durable screenshots, accessibility trees, test sources and results are included here.

If the temporary workspace has been removed, create a disposable checkout at `ec3dd6b544cba1f796c353134dc4af0437cf40a8`, install dependencies and build the distribution there. Restore only the desired probe, removing its extra `.txt` suffix:

| Saved probe | Restore within the disposable checkout |
|---|---|
| Execution | `server/helmsman/adversarial-execution.audit.test.ts` |
| GitHub | `src/plugins/github/adversarial-reconcile.audit.test.ts` |
| Todos | `src/plugins/todos/todos-adversarial-probe.test.ts` |
| Outcomes | `server/helmsman/outcomes-adversarial-probe.test.ts` |
| UI | `tests/distribution/codex-ui-adversarial.pw.ts` |
| Root browser | `review-csrf.ts` |

Update the captured absolute scratch/release paths to new disposable directories. Architecture scripts import the compiled release using relative paths; recreate their recorded `probes/codex_architecture` and `integration/release` layout or adjust those imports. The execution probe's `probeRoot` must exist before running it. UI probes must use copied release fixtures, not a user's live server. Run Vitest/Playwright from that disposable checkout using the commands in the source reports. The root browser probe uses `tsx`; the retained-loader memory probe needs `node --expose-gc`.

Do not point these probes at live data. They create and manipulate temporary stores, deliberately inject failures, and demonstrate deletion/stop behavior inside disposable fixtures. No production fix is encoded in this evidence bundle.

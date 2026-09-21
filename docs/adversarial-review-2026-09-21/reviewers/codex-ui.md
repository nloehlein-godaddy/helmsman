# Codex UI adversarial audit

Reviewed detached `ec3dd6b544cba1f796c353134dc4af0437cf40a8` against baseline `e471d86630d78f2285611e81256ff912e5f57d0e`. I used only `/private/tmp/helmsman-adversarial-20260921-ec3dd6b/codex_ui` and the immutable copied release at `/private/tmp/helmsman-adversarial-20260921-ec3dd6b/integration/release`. No production source was changed, committed, or pushed.

## Confirmed findings

### P2 — Helm layout controls have ambiguous accessible names, including immediate removal

Source: `src/plugins/helm/page.ts:125-157`.

Steps:

1. Open `/helm` and wait until `#boot` is detached and the real Helm page is visible.
2. Expand **Manage panels**.
3. Navigate its controls with a screen reader, voice control, or the accessibility tree.

Expected: repeated controls identify their panel or instance, such as “Remove Underway”, “Duplicate Backlog”, “Move Recent left”, “Apply scope to Pull requests”, and “Stack Activity log”.

Observed: the eight default rows expose eight controls named only “Remove”, eight named “Duplicate”, and repeated “Apply scope”, “Move …”, “Stack”, and “Stack with panel” controls. The panel title is a sibling `<strong>` inside an unlabelled `<div>`, so it does not contribute to the control's accessible name or a named group. The captured Chromium accessibility tree confirms this. The implementation binds each button to the correct instance; I did not reproduce wrong action targeting. The defect is that assistive technology and voice control cannot identify which repeated command they are about to invoke. `Remove` immediately persists layout removal and discards that instance's opaque panel state, so selecting the wrong repeated control can lose browser-local drafts/state.

Artifacts:

- `probes/codex_ui/helm-manager-accessibility.txt`
- `probes/codex_ui/helm-manager-ambiguous-controls.png`
- `probes/codex_ui/accessibility-trace.zip`

### P2 — Cross-galleon runs with the same task key are indistinguishable in history controls and viewer tabs

Sources: `src/plugins/run-history/panel.ts:93-96`; `src/plugins/run-viewer/panel.ts:289-301`.

Steps:

1. Seed retained runs `same-a` in `org/a` and `same-b` in `org/b`, both with display key `TASK-1` and distinct logs.
2. Open `/run-history` with All galleons selected.
3. Open both runs in the shared viewer and inspect the accessibility tree/tab list.

Expected: the history controls and open-run tabs include canonical context, for example “TASK-1 — org/a — same-a” and “TASK-1 — org/b — same-b”.

Observed: history exposes two buttons both named `TASK-1`; the viewer exposes two tabs both named `TASK-1`. Repository/run identity is visible in sibling text, but the viewer tab list contains no such context. The `title` attribute set on viewer tabs was not exposed as a name or description in the captured Chromium accessibility tree. The correct run was loaded for each click and no wrong-run action binding was reproduced. Keyboard and assistive-technology users cannot directly distinguish the two choices, which is material because stop/retry/download controls apply to the selected canonical run.

Artifacts:

- `probes/codex_ui/duplicate-run-accessibility.txt`
- `probes/codex_ui/duplicate-run-identities.png`
- `probes/codex_ui/accessibility-trace.zip`

No P0 or P1 defect was confirmed.

## Stateful production-distribution probes

Five final scenarios passed in Chromium using `fixture({ distribution: '/private/tmp/helmsman-adversarial-20260921-ec3dd6b/integration/release' })`. Every fixture used port `0`, isolated SQLite/operator/plugin directories, fake `git`, `gh`, agent, terminal, Docker, and AppleScript commands, and no live credentials.

1. Shell inventory and responsive navigation: exercised Helm, PRs, Triage, Todos, Terminal, Bugs, Runs, Costs & Outcomes, Campaigns, Agent questions, Config, Communication, Local Git, Jira settings, GitHub settings, Source settings, and standalone Recovery. The probe waited for `#boot` to have count zero, then required visible, non-empty `#page-content` for application pages. Arrow-key/Enter page-tab navigation worked. No document overflow occurred on the desktop inventory or the representative 390×844 Helm, Todos, Runs, Config, Communication, Local Git, and Recovery checks. Explicitly disabling `helmsman.todos-ui` showed Page unavailable without loading the built-in page as fallback; re-enabling restored the selected page and retained `org/a` scope.
2. Durable Todo mutation: created one isolated `org/a` Todo while deliberately losing the successful `/api/source-commands` response. The exact UUID request and original `org/a` selection remained journaled. A newer unsent description survived switching the header to `org/b`, mutation controls were disabled out of scope, disabling/re-enabling `helmsman.todos-ui`, switching back to `org/a`, and checking/applying the original receipt. The backend contained exactly one task with the originally submitted description; the newer draft remained in the editor. No duplicate mutation occurred.
3. Accessibility identity fixture: seeded two same-key, cross-galleon runs, loaded both logs, and captured the confirmed findings above. Canonical action binding and log selection stayed correct.
4. Two-tab layout convergence: two live pages shared the composition database. Removing Backlog in one tab disappeared in the peer; duplicating Underway in the peer appeared in the first tab. Both tabs reloaded with Backlog still absent and exactly two Underway instances. No removed default was automatically restored.
5. Costs replacement lifecycle: independently compiled and installed `example.isolated/page`, selected it for `helmsman/costs-page`, verified live `org/a`→`org/b` scope updates, disabled it, and observed explicit Page unavailable with no built-in Costs fallback. Re-enabling restored the selected replacement. Only an explicit `select … default` switched back to built-in Costs.

Instrumented page-error collections were empty in the shell inventory, Todo mutation, and accessibility scenarios. Non-resource console errors were empty in the full shell inventory.

## Tested negatives

- No stale org/a response painted into the org/b Todo scope.
- No draft loss across scope switching, plugin disable/re-enable, or original-receipt reconciliation.
- No duplicate Todo command after response loss.
- No implicit built-in fallback for a disabled selected page.
- No replacement of intentionally removed layout entries after peer updates or reload.
- No header-scope mutation from panel-owned explicit run selection.
- No horizontal document overflow in the tested desktop/mobile routes.
- Empty/unavailable states for PR reads, terminal connection, Slack destination, task views, and Local Git checkout inspection remained explicit under fake providers.
- Recovery rendered and filtered its isolated state without invoking an action when no eligible retained recovery record existed.

## Accessibility improvement kept separate from defects

At 390px, the Recovery plugin lifecycle table remains within the viewport but compresses `State`, `Health`, and `Actions` values into heavily wrapped narrow columns. The data is still present and associated with its row, so I did not classify it as a defect. A minimum table width with horizontal scrolling, already used by command tables, would improve readability. Artifact: `probes/codex_ui/recovery-mobile.png`.

## Scope limits

- Browser execution was Chromium only. I did not rerun the aggregate cross-browser or visual snapshot suite.
- Slack/GitHub/Jira, real terminals, real Git operations, agents, Docker, and credentials were intentionally unavailable. Their shipped presentations and unavailable/error states were exercised; no live external side effects were attempted.
- The representative backend mutation was a Todo command. Campaign, PR review, communication, terminal, and Local Git destructive controls were not submitted because the fixture intentionally denied their live providers.
- I did not update baseline screenshots or build the application. Root supplied a fresh passing TypeScript/application/distribution build in `logs/current-build.log` before the browser probes.

## Commands and results

- `git rev-parse HEAD` → `ec3dd6b544cba1f796c353134dc4af0437cf40a8`; worktree initially clean.
- `cat AGENTS.md`, `sed`/`rg` reads over `DESIGN.md`, `PRODUCT.md`, recovery/plugin authoring and implementation docs, frontend routes, hosts, composition store/host, and owned panel sources → completed; no files changed.
- `npx playwright test --config playwright.distribution.config.ts tests/distribution/codex-ui-adversarial.pw.ts --trace=on` → final initial three scenarios: **3 passed (1.5m)**.
- `npx playwright test --config playwright.distribution.config.ts tests/distribution/codex-ui-adversarial.pw.ts --grep 'two live tabs' --trace=on` → **1 passed (9.3s)**.
- `npx playwright test --config playwright.distribution.config.ts tests/distribution/codex-ui-adversarial.pw.ts --grep 'Costs replacement' --trace=on` → **1 passed (12.6s)**.
- Early probe iterations failed only because of review-test mistakes: unsupported `toBeDetached`, a Pirate-mode-dependent PR label, use of `/costs` instead of canonical `/outcomes`, strict locators matching multiple intentional elements, treating the source-command JSON body as wrapped instead of direct, and a strict accessibility-snapshot locator. Each probe was corrected before evidence collection; none represented a product failure.

The final probe source is preserved at `probes/codex_ui/codex-ui-adversarial.pw.ts`. Traces are `shell-inventory-trace.zip`, `todo-lost-response-trace.zip`, `accessibility-trace.zip`, `layout-convergence-trace.zip`, and `costs-replacement-trace.zip` in the same directory. Screenshots and accessibility-tree text files are alongside them.

_Helmsman · gpt-5.6-sol - high_

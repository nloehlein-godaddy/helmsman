# Codex UI adversarial audit

Reviewed detached `e3ccca4d6b31db70974f4c8e70784e491768d9c8` against prior reviewed `ec3dd6b544cba1f796c353134dc4af0437cf40a8` and rewrite baseline `e471d86630d78f2285611e81256ff912e5f57d0e`. Browser probes used the copied release at `/private/tmp/helmsman-adversarial2-20260921-e3ccca4/integration/release` after its `READY` marker. No production source, live application, credentials, user data, external service, native terminal, agent, Docker process, commit, or push was used.

## Confirmed finding

### P3 — malformed JSON disables automatic starts instead of being rejected

Sources: `server/helmsman/application.ts:1457-1464`; `server/helmsman/router.ts:426-431`.

Execution-proven trigger:

1. Enable automatic starts for `org/a` through the installed same-origin JSON client; `/api/agents` reports `autoClaim: ["org/a"]`.
2. Send `POST /api/repos/org%2Fa/auto-claim` with `Content-Type: application/json` and the malformed raw body `{`.
3. Read `/api/agents` again.

Expected: malformed JSON is rejected with 400 and the prior setting remains enabled.

Observed: `readBody` converts the parse error to `null`; the auto-claim route interprets a missing `enabled` property as `false`, returns 200 `{"repo":"org/a","enabled":false}`, and `/api/agents` then reports an empty `autoClaim` list. The malformed `/api/config` negative control returned 400, confirming the behavior is route-specific. No shipped browser caller emits malformed JSON; impact requires a faulty or hand-written same-origin/local client, but the request silently performs the opposite durable mutation rather than failing.

Reproduction:

```sh
cd /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_ui
./node_modules/.bin/playwright test --config playwright.config.ts --grep 'request guard'
```

Evidence: `probes/codex_ui/request-guard-browser-clients.json`, `probes/codex_ui/request-guard-trace.zip`, and the passing scenario in `probes/codex_ui/codex-ui-second.pw.ts`.

Minimal fix direction: distinguish an absent body from a JSON parse failure and return 400 for malformed JSON before dispatch. Independently require the auto-claim input to be a non-array object with exactly a boolean `enabled` field. Preserve the intentionally bodyless Stop client behavior.

No P0, P1, or P2 issue was confirmed.

## R11/R12 verification and negative controls

- R11 passed with a duplicated panel. Groups and every button/input/select exposed the complete title and instance ID; stack destinations contained complete IDs, including UUIDs. Applying an explicit `org/b` scope to the duplicate left header scope at `org/a`. Removing the duplicate by its full accessible identity removed only that UUID; the original survived reload. No wrong-target action reproduced.
- R12 passed with three `TASK-1` runs: two in `org/a`, one in `org/b`, attempts 2/3/4, and IDs sharing 61 leading characters. History choices and resolved viewer tabs exposed display key, galleon, full run ID, and attempt. Home/ArrowRight selected the intended logs; closing the second run retained the first and cross-galleon run. After reload, an inactive unresolved tab honestly used canonical repo/run identity until activation resolved its current display key and attempt. Actions and visible logs stayed bound to the selected canonical run.
- Full run labels wrapped without clipping on desktop and 390×844 mobile. A 6,000-character log event was bounded to the documented 4,000-character preview and disclosed `[preview clipped]`; the page did not overflow.
- In-place navigation between Run history and Helm retained the exact viewer host DOM and both run tabs. Reload with canonical `run`/`runRepo` restored the session and revalidated the inactive tab before use.

Artifacts: `helm-duplicate-accessibility.txt`, `identities-trace.zip`, `same-key-long-prefix-accessibility.txt`, `same-key-long-prefix-runs-desktop.png`, and `same-key-long-prefix-runs-mobile.png` under `probes/codex_ui`.

## Other installed UI coverage

Five final Chromium scenarios passed against isolated fixtures:

1. Visited Helm, PRs, Triage, Todos, Terminal, Bugs, Runs, Costs & Outcomes, Campaigns, Agent Questions, Config, Communication, Local Git, Jira settings, GitHub settings, Source settings, and Recovery. Every route rendered non-empty content; desktop and representative 390×844 routes had no document overflow. Arrow/Enter view navigation worked. The notification disclosure returned focus on Escape. Null and malformed run-history responses produced an explicit unavailable state without page errors.
2. Duplicated/scoped/removed panels and exercised the same-key/long-prefix run fixture described above. The same viewer session survived navigation, and reload revalidated retained tabs.
3. Two tabs converged Backlog removal and Underway duplication; reload did not restore the removed default. An independently compiled Costs page replacement followed `org/a` to `org/b`, remained explicitly unavailable while disabled, returned on re-enable with `org/b`, and changed to built-in only after explicit default reset.
4. Same-origin installed clients successfully sent JSON auto-claim and bodyless Stop requests. Cross-origin JSON and same-origin `text/plain` mutations returned 403. The malformed-JSON mutation above was the only confirmed defect.
5. A deliberately lost successful Todo response retained its UUID and original `org/a` selection. A newer unsent draft survived header scope change, out-of-scope disabled controls, plugin disable/re-enable, receipt check, and result application. The backend contained exactly one Todo with the submitted value while the editor retained the newer draft.

The final command was:

```sh
./node_modules/.bin/playwright test --config playwright.config.ts
```

Result: **5 passed (2.1m)**. Stable traces are `shell-responsive-trace.zip`, `identities-trace.zip`, `convergence-replacement-trace.zip`, `request-guard-trace.zip`, and `todo-recovery-trace.zip` under `probes/codex_ui`. Screenshots were visually inspected. Every fixture closed through `finally`; the passing run left no owned server or browser fixture active. The detached production worktree remained clean.

## Historical seams and source reviewed

Read the current product/design guides, plugin implementation ledger, page/panel/recovery/distribution guides, prior UI report, fix ledger, and the A–G completion history. Source inspection covered shell routing and auxiliary rehoming, composition/page/panel hosts and state persistence, Helm layout controls, run history/viewer validation and journals, task drafts, communication focus handling, plugin selection/disablement, and the request-origin/body boundary. Prior completion and regression claims were treated as hypotheses; the installed probes independently exercised the relevant paths.

## Secondary UX improvement

Duplicated Helm manager rows render the shared panel title but not that row's own instance ID. The complete identity is available to assistive technology, and complete UUIDs are visible in the other rows' stack-destination options. Canonical targeting passed, so this is not a recurrence of R11. Showing a compact instance suffix beside each duplicated title would help sighted users correlate a row with stack choices. Evidence: `helm-duplicate-visible-identity.json` and `helm-duplicate-visible-identity.png`.

## Explicit gaps

- Chromium only; Firefox, WebKit, an actual screen reader, and voice-control software were not run.
- Live GitHub, Jira, Slack, terminals, Git, agents, Docker, credentials, and external URLs were intentionally unavailable. Their isolated unavailable/empty presentation was exercised; no external or destructive action was submitted.
- Campaign, PR review, terminal-control, Local Git cleanup, and Recovery mutations were not issued. Todo supplied the durable lost-response mutation case.
- Root owns the full unit, TypeScript, build, visual baseline, and standard distribution checks; they were not duplicated here.

_Helmsman · gpt-5.6-sol - high_

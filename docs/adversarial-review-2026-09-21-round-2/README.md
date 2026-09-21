# Second review evidence

Read the [consolidated report](../adversarial-review-2026-09-21-round-2.md) first. It adjudicates the six independent reviews, severity, controls and limits. All primary reviewers completed against `e3ccca4d6b31db70974f4c8e70784e491768d9c8` before consolidation.

- `reviewers/`: verbatim primary reviewer reports and any separately identified follow-up.
- `evidence/`: selected deterministic observations, probe sources, test/build logs, accessibility snapshots and screenshots.
- [metadata.json](metadata.json): audited revisions, scope, actual models, configured efforts and Claude completion records.
- `sha256.json`: SHA-256 of every companion file except the manifest itself, captured after final assembly.

No raw model transcripts, credentials, temporary databases, release archives or runtime state are included. Browser traces remain in the temporary review workspace; selected screenshots/JSON and the complete browser probe are preserved here. The original first-review and fix evidence remain unchanged.

## Reading the independent reports

Independent outputs are intentionally not silently rewritten. The consolidated report applies these corrections:

1. Security's “all sound” and “all primary claims execution-proven” language is too broad. Its 29 guard and eight HTTP cases executed, while deeper file/gateway/publication boundaries were primarily inspected. A loopback service can be exposed to browser CSRF without cookies; browser local-network restrictions vary. No bypass was confirmed in the actual checks.
2. UI's malformed-body finding changes reversible process-local legacy auto-claim state, not a demonstrated durable setting. Validated source-admin commands power the current automatic-start UI. P3 reflects the absence of a shipped malformed caller.
3. Domain's lease-contention probe uses two real database connections in one process, not two OS processes. Initial probe execution hit a fixture scope/path mismatch; its corrected fixture reaches the intended lease fence and passes.
4. Domain's completion summary says 520 existing tests; captured tool outputs show batches of **85 and 444** (529 executions, not necessarily distinct tests), plus two new probes. All overlap the baseline suite. Its first batch listed eight filenames but Vitest discovered seven files. The preserved result excerpts are authoritative.
5. Domain's suggested “no host reference means no worker ran” comment is rejected. A launching attempt can lose acknowledgement after process start. Never-launched settlement also requires the preparation state and explicit recorded evidence. Absence of a host reference alone must not authorize cleanup or capacity release.
6. Claude launch records specify `--effort high`; the source review's self-reported “medium” and integrations' “not reported” bylines do not override those launch records. Reports remain verbatim; consolidated metadata uses the actual configured CLI value.
7. GitHub lost-ack recovery can be cleared through manual `resolve-operation`. RR06 is failed automatic reconciliation, not absolute unrecoverability or proof of duplicate sends. Its probe mocks provider HTTP and the downstream durable consequence was traced.

## Reproduction

Original workspace: `/private/tmp/helmsman-adversarial2-20260921-e3ccca4`. Each lane was a detached worktree at the audited SHA. `integration/release` was freshly built from that SHA and copied by installed fixtures; it was never a release symlink. Dependencies were reused without modification. The full suite ran from the canonical checkout to avoid dependency-realpath fixture differences.

Executable evidence receives an additional `.txt` suffix so ordinary test discovery cannot collect it. To replay:

1. Create a disposable checkout at the audited SHA and install compatible dependencies (recorded environment: Node 24.17.0, macOS arm64).
2. Build the distribution once with `npm run build:distribution`. Inspect the preserved probe's path constants/imports and point them to that checkout and its actual distribution directory. Several probes retain absolute paths for audit fidelity; they are not drop-in portable commands.
3. Copy only the desired source out of this evidence directory, removing the final `.txt` suffix. Place Vitest probes at their original relative source locations so their imports resolve. Execution's combined audit belongs at `server/helmsman/adversarial2-execution.audit.test.ts`; domain's probe belongs at `server/helmsman/adversarial-probe.test.ts`. The GitHub probe also needs its absolute provider import relocated.
4. Use the focused commands in the individual reports. Architecture `.mjs` scripts use Node; the `.mts` cleanup script needs `tsx`. Chromium uses the retained Playwright config and browser probe. Browser `last-run.json` records the passing final run; large traces are not archived here.
5. Keep all Git/worktree/process effects in the probes' disposable roots, retain their exact owned-handle cleanup, and never point them at a user's runtime or checkout. Passing defect probes reproduce the defect; they are not acceptance tests for a fix.

The root independently replayed RR01–RR06. RR01 also has an actual compiled-server startup probe. RR07 has installed Chromium evidence and a separate source/severity adjudication. Historical host source/descriptor evidence is copied only for the isolated compatibility fixture; it is not installed into this project's runtime.

_Helmsman · not reported - not reported_

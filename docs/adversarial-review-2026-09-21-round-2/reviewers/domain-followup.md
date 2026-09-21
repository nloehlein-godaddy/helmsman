# Bounded independent current-code domain follow-up

**No new confirmed defect in this follow-up.** This is additional current-code review of campaign scheduling, contacts, task-view scope and pricing/accounting at `e3ccca4d6b31db70974f4c8e70784e491768d9c8`, requested because the domain review explicitly carried forward its earlier reading of unchanged files. Unchanged code was not treated as proof of correctness.

The domain review's proposed explanation/comment about missing host references is **incorrect and should not be adopted**. See the adjudication below.

## Current code inspected

- `server/helmsman/campaign-dispatcher.ts`: claim reconciliation, retained trigger proposals, candidate eligibility/window rotation, stable run identity, repeated-poll guard and claim rechecks.
- `server/helmsman/campaigns.ts`: CSV/JSONL parsing, configured galleon override normalization, record deduplication, phase ordering/transitions, concurrency and same-galleon claim exclusion, token/attempt-fenced settlement and retry.
- `server/helmsman/campaigns-public-service.ts` and `src/plugins/campaigns.ts`: header scope, campaign ownership, preview digest, configured task overrides, revisions and exact-request receipts. Explicit imported task overrides are a documented feature, not a scope violation (`docs/campaigns-authoring.md:9`).
- `server/helmsman/task-source-schedule.ts`, `scheduling-runtime.ts`, `scheduler.ts` and `src/plugins/scheduling/provider.ts`: explicit source selection, duplicate logical namespaces, readiness/scope/quarantine checks, bounded cursor discovery, policy and cursor revisions, single-use decision tokens and per-heartbeat admission guards.
- `server/helmsman/task-views-read-service.ts`, `src/plugins/task-views.ts`, and relevant service tests: scope/source/revision rechecks around asynchronous reads, strict task refs, related-run scope, duplicate items, quality/count semantics and time/size limits.
- `server/helmsman/suggested-contact-admin-service.ts`, `clarification-service-common.ts`, `src/plugins/suggested-contact-admin.ts` and contact sections of `clarification-services.test.ts`: explicitly global contacts, contribution authority, caller-bound cursors/receipts, optimistic revisions and transactionally coupled mutation/receipt handling.
- `src/plugins/pricing/standard.ts`, `server/helmsman/usage-store.ts`, `usage-service.ts`, and previously inspected `plugins/backend.ts` pricing-result validation: reported-versus-estimated separation, cached token arithmetic, unknown prices, finite/safe numeric limits, event identity and aggregation.
- Only the narrowly relevant never-launched predicate/writer/launch ordering was reread in `execution-store.ts`, `runner-durability.ts` and `runner.ts`; source-claim settlement work was not repeated.

## Executed adversarial controls

`probes/codex_architecture/domain-followup.mjs` imports the root reviewer's fresh distribution. It uses temporary real SQLite stores for campaigns, contact state/receipts and scheduling cursor persistence, with inert injected launch/provider callbacks. It does not launch workers or contact external services.

All assertions passed:

| Area | Executed checks |
|---|---|
| Campaigns | Repeated identical import rows deduplicate; confirming the same preview twice creates no duplicate tasks. Explicit configured galleon overrides survive while unconfigured overrides/null rows reject. Foreign header scope rejects detail reads. NaN, Infinity, fractional and out-of-range concurrency reject. Concurrent polls on two dispatcher instances launch two distinct initial run IDs on two distinct galleons, never the second same-galleon task while its first is active; after settlement exactly one further task launches. |
| Scheduling | Two simultaneous discoveries against the same cursor revision produce one usable decision. Admission consumes that decision once; reuse rejects. A foreign-galleon candidate is filtered, selecting a foreign source or duplicate instance rejects, and null policy input returns no choice. |
| Task views | Correct scope succeeds. Foreign page scope, foreign source refs, foreign related-run scope, duplicate items and null provider payload all reject. A source revision changing during the provider read rejects the late response. |
| Contacts | Real SQLite create succeeds; exact command replay returns the same receipt; changed content under the same request ID conflicts. Update advances revision; a stale update rejects. Null input, non-global scope and a string boolean reject. Another authorized contribution cannot read the first caller's receipt. |
| Pricing/accounting | Astra example with 1,000 input, 400 cached and 100 output tokens computes $0.0114. Unsupported model, already reported cost, invalid/negative/fractional tokens and cached tokens exceeding input remain unpriced. Invalid usage records reject. Exact duplicate events deduplicate; same-key conflicting costs reject. Foreign-galleon rows/events are excluded and aggregate token overflow rejects. A run's older reported total does not become a known complete cost when current event-level cost remains unknown. |
| Never-launched predicate | A null host reference alone returns false in every preparation state. Even an explicit evidence tag does not make `launching` or `launched` an unlaunched outcome. |

One initial probe clock mismatch used a fixed campaign-store timestamp with a real-time dispatcher clock, making claims artificially expired. The final probe aligns both injected clocks; the anomalous extra callback was a fixture artifact and is not reported as a production duplicate-launch defect. Actual uncertain launch recovery still requires independent durable evidence and was outside this probe's scope.

Evidence: `probes/codex_architecture/domain-followup.mjs` and `domain-followup.log`.

```sh
node /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/domain-followup.mjs
```

## Adjudication: no host reference is not proof that no worker ran

The source review says the effective guarantee is “no host reference was ever recorded” and proposes a comment saying “only host attachment establishes worker progress.” Both formulations omit the critical durable launch-state boundary and would mislead future recovery changes.

The actual predicate at `server/helmsman/execution-store.ts:48` requires all three conditions:

1. Preparation is `prepared` or `ready`.
2. `hostRef` is null.
3. The recorded outcome carries explicit `kind: 'never-launched'` evidence.

`runner-durability.ts:79–91` writes that outcome only after lease and preparation-state checks, with additional unresolved-claim-operation protection. `runner.ts:750` and `:801` mark the attempt `launching` before handing off launch. A worker can start and the acknowledgment can be lost before `launched()` records its reference. That attempt can have `hostRef === null` while a real worker ran or is still running; it must stay uncertain. Worktree presence by itself proves neither launch nor non-launch.

The predicate's name is consistent with the proven pre-launch state plus explicit terminal evidence. Do not replace that guarantee with a host-reference-only rule or add the proposed comment. If clarification is desired, explain the distinction between proven pre-launch failure and launch with uncertain acknowledgment; preserve all current fences.

## Limits

This was a bounded follow-up, not another complete domain audit. No full suite or build was run; production files remain unchanged and the assigned worktree is clean. No source-claim settlement, real Jira/Slack/GitHub integration, browser interaction or external worker was exercised. Campaign callbacks are inert and scheduling/task-view providers are injected boundaries, so these probes do not establish live remote pagination behavior or multi-process launch idempotency after lease expiry. Contact cursor signing and full SQL rollback under injected storage faults were inspected but not re-executed in this addendum. Pricing checks establish arithmetic and accounting behavior, not the commercial accuracy of the dated rate table. Large-history performance, all malformed shapes, every campaign interleaving and outcomes classification were not exhaustively examined.

_Helmsman · gpt-6-astra - high_

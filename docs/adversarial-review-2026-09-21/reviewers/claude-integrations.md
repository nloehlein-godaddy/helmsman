# Adversarial Audit — External Integration & Side-Effect Correctness

- **HEAD reviewed:** `ec3dd6b544cba1f796c353134dc4af0437cf40a8`
- **Baseline for A–G rewrite:** `e471d86630d78f2285611e81256ff912e5f57d0e`
- **Area:** GitHub PR reads/diffs/head-binding, manual/automated review + rerun, own-PR eligibility, exact-review publication, durable remote-effect ledger/reconciliation, Slack/communication delivery, webhook intake/dedupe, clarification gate/contacts, rate-limits/pagination, plus newest fixes `311185c`/`ec3dd6b`/`553dff4` and native cmux cost automation.
- **Constraints honored:** No production edits, commits, pushes, real network, real credentials, agent launches, or Docker actions. Probes used in-process fakes only. No PIDs killed. Repo tree left clean (probe removed after use; copy saved as artifact).

---

## Summary of findings

| # | Severity | Type | Title |
|---|----------|------|-------|
| 1 | **Medium** | Confirmed (executable) | Plugin `reconcileReview` reads only the first page of reviews — cannot confirm a delivered review on PRs with ≥100 reviews (regression vs. legacy path) |
| 2 | Low | Confirmed (executable) | Review/operation `invokeReview` treats HTTP 403 as permanently non-retryable (secondary rate limits) |
| 3 | Low | Static | Slack `reconcileReviewRequest` never self-heals a lost-ack send (always `unknown`) |
| 4 | Low | Static | cmux refresh lock can wedge on PID reuse (local-only automation) |

All confirmed findings preserve the core safety invariants (no *automatic* duplicate remote action, no invented success, no retargeted obligation). Finding #1 is the one behavioral regression that can *indirectly* lead to a duplicate via operator misjudgment and defeats automatic recovery.

---

## Finding 1 — `reconcileReview` does not paginate; delivered reviews on heavily-reviewed PRs are never confirmed  (MEDIUM, confirmed)

**Location:** `src/plugins/github/provider.ts:285` (`reconcileReview`).

```ts
const response = await request(context, 'GET', `/repos/${input.repo}/pulls/${input.number}/reviews`,
  { per_page: '100', page: '1' }); const values = array(response.body, 100);
...
const found = values.map(object).filter(value => ... value?.body === expectedBody ...);
if (found.length !== 1) return unavailable('No authenticated review receipt proves delivery; ...');
```

**Reachable trigger / active wiring:** This provider is the builtin PR provider resolved by `server/helmsman/pull-request-provider-effects.ts` → `execute('reconcileReview', …)`, which backs the **current public/manual review path** (`pull-request-command-routes.ts` → `pull-request-command-service.ts` `submit`/`retry`/`drainPending`, all dispatched with `{ reconcile: true }`). `reconcileReview` runs whenever `invokeReview` returns `unknown` (lost acknowledgment) or on crash recovery (the ledger persists `requiresReconciliation=1` in `operations.markInvoked` *before* the network call — `server/helmsman/operations.ts:284`).

**Defect:** Only page 1 (oldest 100) of `GET /pulls/{n}/reviews` is inspected. GitHub returns reviews in ascending submission order, so a **newly-posted** review sits on the *last* page. On any PR that already has ≥100 reviews, the just-submitted Helmsman review is on page ≥2 and is never seen. `array(response.body, 100)` accepts a full 100-item page without error and the Link/`next` header is ignored.

**Expected vs. observed:**
- Expected: reconcile follows pages (like the detail path `reviews()` which uses `collection()` and follows `next`, and like the legacy `server/helmsman/operation-github.ts:62-76` reconcile which loops `page=1..20` until `reviews.length < 100`) and returns `acknowledged` for the delivered review.
- Observed: returns `status: 'unknown'` → operation stays `uncertain` / receipt projects `recovery-required` (`pull-request-command-service.ts:73`). Never self-heals.

**Impact:**
- Automatic recovery for the public review path breaks on heavily-reviewed PRs; the operation is stuck `uncertain` indefinitely.
- Safety still holds automatically: `requiresReconciliation` stays set, so the ledger will **not** re-invoke → no automatic duplicate; success is never invented.
- **Indirect duplicate risk:** an operator seeing “recovery-required” who resolves with `definitely-not-applied` (believing it was not sent) resets the op to `pending` (`operations.ts:330`), permitting a fresh `invoke` → a **second review posted**. The reconcile’s inability to prove the (real) delivery is what invites that mistake.
- This is a **regression introduced by the A–G plugin extraction**: the retained legacy adapter (`operation-github.ts`) paginates correctly; the extracted plugin does not.

**Reproduction (executable):** `probes/claude_integrations/reconcile-pagination-probe.test.ts`
```
npx vitest run <that file>
```
Actual output:
```
MARKER used: "my review\n\n<!-- helmsman-operation:op-id:hash -->"
RECONCILE RESULT: {"status":"unknown","reason":"No authenticated review receipt proves delivery; ...","evidence":{"code":"github-unconfirmed"}}
CONTROL RESULT: {"status":"acknowledged","receipt":{...,"reviewId":55}}   // same marker on page 1
```
Page 1 was returned full (100 unrelated reviews) *with* a `rel="next"` Link header pointing to page 2; the delivered marker on page 2 is never fetched. Control (marker on page 1) → `acknowledged`. 4/4 probe assertions pass.

**Minimal fix direction:** Make `reconcileReview` paginate like `operation-github.ts` (loop pages up to a bound, stop on `length < 100` or on match, treat `>20` pages as `unknown`), or query reviews in descending order first. Do **not** stop at page 1.

---

## Finding 2 — 403 treated as permanently non-retryable on review write  (LOW, confirmed)

**Location:** `src/plugins/github/provider.ts:275` and `server/helmsman/operation-github.ts:29-33` (`rejected`).

```ts
return response.status >= 400 && response.status < 500
  ? { status: 'definitely-not-applied', retryable: response.status === 429, ... }
  : unavailable(...);
```

**Observed (executable probe):** POST `/reviews` → 403 yields `{status:'definitely-not-applied', retryable:false}`; 429 yields `retryable:true`. Because a non-retryable `definitely-not-applied` settles to `blocked`/`delivery-blocked` which is **permanently un-leasable even under reconcile** (`operations.ts:256`), a review blocked by a GitHub **secondary rate limit / abuse detection returned as 403** is permanently blocked and requires operator retry.

**Impact / severity:** Low. It is safe (403 means the write did not apply → no duplicate/invented success). It is a resilience gap only. This behavior is *consistent* between the plugin and legacy paths, i.e. an intentional design choice, and modern GitHub secondary limits mostly return 429. Noted as an improvement, not a bug.

**Fix direction (optional):** Treat 403 responses carrying `Retry-After` / secondary-rate-limit signals as retryable, or map them to `unknown` rather than a permanent block.

---

## Finding 3 — Slack `reconcileReviewRequest` never confirms a delivered request  (LOW, static)

**Location:** `src/plugins/slack/provider.ts:64-68`.

```ts
async reconcileReviewRequest(input, context) {
  ...
  try { configured(context); return unknown('Slack has no durable exact receipt for this request; automatic resend is prohibited.'); }
  ...
}
```

`invokeReviewRequest` embeds a UUID `requestId` in the sent message and a `scanReviewRequests` reader exists, but `reconcileReviewRequest` unconditionally returns `unknown`. Any Slack review-request send whose acknowledgment is lost stays `uncertain`/`recovery-required` forever until an operator resolves it. This is explicitly conservative (browser transport has no reliable idempotent lookup; “automatic resend is prohibited”) and preserves no-duplicate/no-invented-success. It is a **behavior change from the retained legacy adapter** (`operation-queues.ts` `createSlackReviewOperationAdapter`, which reconciles via a `receipt()` lookup — see `operation-effects.test.ts:203`). Flagged so the intentional loss of self-healing is on record; consider using `scanReviewRequests` to match the embedded `requestId` for read-only confirmation.

---

## Finding 4 — cmux refresh lock can wedge on PID reuse  (LOW, static, local-only)

**Location:** `server/helmsman/cmux/codex-cost-sidebar.ts:218-240` (`acquireLock`).

A held lock file storing a numeric PID is considered live whenever `process.kill(pid, 0)` succeeds. If the original refresher died and its PID was recycled by an unrelated process, the probe succeeds and the lock is treated as held with **no staleness timeout** (the 60s mtime fallback only applies to non-numeric PID contents). Result: local Codex cost refresh stops until manual cleanup. Local-only automation, no remote effect; `process.kill(pid,0)` is a liveness probe of the lock’s *own* recorded PID (not a guessed process), so it does not violate the no-kill constraint. Low severity. Fix: also enforce an mtime-based staleness bound for the numeric-PID branch.

---

## Newest-fix verification (current-state checks)

- **`ec3dd6b` (concurrent GitHub review reads):** Correct. Old code `sources = [{…await search…}, ...(await local)]` awaited `search` first; if `local` (a `Promise.all`) rejected while `search` was pending, `local`’s rejection had no handler → unhandled rejection. The fix `await Promise.all([search, local])` attaches handlers to both. Verified: `npx vitest run src/plugins/github/provider.test.ts` → **9/9 pass**, including the new `it.each(['search','local'])` case (`ctx.http.request` called exactly twice; result `degraded`).
- **`311185c` (native cmux cost refresh):** Correct and necessary. Under Node 24 native TS type-stripping, value imports need explicit extensions; the fix added `.ts` to the `estimateRecord` import/re-export in `server/helmsman/cost-estimates.ts`. The sibling type-only import (`../../src/plugins/usage`) is erased, so it correctly keeps no extension. Verified end-to-end: `node scripts/cmux-codex-cost.mjs --help` → prints help, exit 0 (the full static import chain `codex-cost-sidebar.ts → cost-estimates.ts → pricing/standard.ts` resolves under native Node). The added test loads the CLI via `execFileSync(process.execPath, …)`. cmux automation is local-only (cmux CLI + local state files); no remote-effect concern.
- **`553dff4` (preserve manual reviews of draft PRs):** Coherent. `allowDraft: !trigger` lets manual reviews (no trigger) proceed on drafts while automated/trigger reviews still reject them (`trigger-review-preparation.ts:10`). The now-real `pr.draft` return value (`:19`) is unused in the review `taskObj` construction (`application.ts:1217-1223`), and the separate automated proposal path still rejects drafts (`application.ts:672`, `trigger-providers.ts:106`, `github-review-watcher.ts:125`, `created-pr-reviews.ts:111`). No side-effect leak found.

---

## Areas inspected and invariants that held (tested negatives)

- **Durable operation ledger** (`server/helmsman/operations.ts`, `operation-dispatcher.ts`): `markInvoked` persists `deliveryAttempts++` and `requiresReconciliation=1` *before* the effect and rejects a second `invoked` event for the same generation (`operations.ts:283`); expired `leased` rows re-lease automatically and inherit `requiresReconciliation`, so post-crash re-dispatch reconciles rather than re-invokes. `delivery-blocked` is permanently un-leasable; `unknown` → `uncertain` reconcilable; operator `resolve(definitely-not-applied)` → `pending`. `enqueue` rejects a differing payload/binding for an existing logical key. Confirms no automatic duplicate / no invented success across crash, restart, and reused request IDs. `npx vitest run operations.test.ts operation-effects.test.ts pull-request-provider-effects.test.ts communication-provider-effects.test.ts` → **48/48 pass**.
- **Exact-review binding** (`provider.ts` `prepared`/`invokeReview`/`reconcileReview`, `pull-request-provider-effects.ts`): pins actor via `/user`, verifies open + `head.sha == expectedHeadSha`, rejects actor rotation, matches the reconcile receipt by an operation-scoped marker `<!-- helmsman-operation:id:contentHash -->`. Effect layer re-checks `sameBinding`/`sameDestination` and forbids reconcile from mutating (`matchesReviewRequest`, `beforeSend`). Head/ownership changes and provider/destination replacement are rejected (also covered by `operation-effects.test.ts`: changed actor, changed remote ref, foreign review history not treated as replay).
- **Webhook intake** (`webhooks.ts`): HMAC-SHA256 + `timingSafeEqual` (32-byte digests); `delivery` PK dedupe; reused delivery with different digest → 409; runId derived deterministically and UNIQUE; secret/credential re-checked inside the insert transaction (rotation → 409); atomic claim UPDATE for redelivery dispatch. No signature-bypass or double-dispatch found for a single process/DB.
- **Automated review dispatch** (`github-review-watcher.ts`, `created-pr-reviews.ts`, `slack/store.ts`): per-notification `INSERT OR IGNORE` dispatch claim + `current.runId`/status re-checks + `findExistingReview` + deterministic head-keyed identity block stale-head reviews and duplicate launches; superseded head → `blocked` (`github-review-watcher.ts:125-134`); removed request → `blocked` (`:223-231`).
- **Own-PR / eligibility:** `metadata` computes `isOwnPr` via case-normalized author vs. configured author and validates `html_url`, state, draft, `merged⇒closed`, head/base SHAs; draft eligibility split correctly per Finding-3 review of `553dff4`.
- **Diff bounds** (`provider.ts diff`): patch budget `remaining` never goes negative (subtraction bounded by `Math.min(remaining, …)`); trailing lone high-surrogate stripped; head re-checked before/after via `same()`; `head-changed` surfaced as a typed error.
- **Clarification gate / trusted contacts** (`clarification-gate.ts`, `contact-policy.ts`): gate requires exact `attempt`+`channel` query params matching retained channel and `active`; contact selection only from enabled contacts with a deterministic precedence. No injection path found.

---

## Limitations

- No full test suite, app build, or distribution build run (per instructions; root owns the single release build).
- No live GitHub/Slack/Jira/Docker/network calls; all probes used in-process fakes and in-memory/temp persistence.
- Findings are from inspected source at HEAD `ec3dd6b` and the four executable probe assertions above; I did not exhaustively read every A–G intermediate commit — I diffed the newest fixes and contrasted the extracted plugin providers against their retained legacy adapters where behavior parity matters.
- GitHub review ordering (ascending by submission) is relied upon in Finding 1’s amplification; the core defect (no pagination) holds regardless of order whenever the match is not among the first 100 results.

---

_Helmsman · claude-opus-4-8 - high_

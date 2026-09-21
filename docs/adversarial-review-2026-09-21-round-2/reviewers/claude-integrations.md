# Adversarial integrations/effects review — 2026-09-21 (second pass)

**Audited HEAD:** `e3ccca4d6b31db70974f4c8e70784e491768d9c8`
**Prior reviewed baseline:** `ec3dd6b544cba1f796c353134dc4af0437cf40a8`
**A–G rewrite base:** `e471d86630d78f2285611e81256ff912e5f57d0e`
**Area:** GitHub / Slack-communication / webhook & review triggers, PR inspection/publication/remote effects, clarification gates, rate limits/cancellation/timeouts, actor/head/binding identity, cmux/native provider seams. Focus on R10 pagination and exact receipt reconciliation.

**Result: 1 confirmed defect (P2, execution-proven) — a new interaction the R10 fix and its tests miss. No P0/P1 found in this area. No false-acknowledgement or auto double-send reproducible.**

---

## Confirmed finding

### I1 (P2) — `reconcileReview` discards a provably-delivered review once the PR head advances or the PR merges/closes

**Code:** `src/plugins/github/provider.ts:282-301` — specifically the `prepared()` gates at `provider.ts:284` (before reading history) and `provider.ts:298-299` (after). `prepared()` itself is `provider.ts:177-183` and requires `head.sha === expectedHeadSha && state === 'open' && merged !== true`.

**Trigger / interleaving (reachable):**
1. `invokeReview` (`provider.ts:271-281`) POSTs the review to head `X` and it lands, but the acknowledgement is lost (TCP reset after GitHub processed it, or process crash before `settle`). The dispatcher has already called `markInvoked` (`operations.ts:279-287`), so `requiresReconciliation=1`; the operation goes `uncertain`.
2. Before the next reconcile lease runs (`pullRequestCommandService.dispatch` → `dispatchOperation(..., { reconcile: true })`, `pull-request-command-service.ts:97`), the PR author pushes a new commit (head → `Y`) or the PR is merged/closed. This is a normal event on an active PR.
3. `reconcileReview` runs. The very first `prepared()` call sees `head=Y ≠ X` (or `state !== 'open'`), throws, and the outer `catch` returns `unavailable(...)` → status `unknown`. The bounded history is never even read, so the genuinely-posted review carrying the exact `<!-- helmsman-operation:<id>:<contentHash> -->` marker at `commit_id === X` is never matched.
4. `settle` records `uncertain`, `requiresReconciliation` stays true. Every subsequent automatic reconcile repeats step 3 — head never returns to `X`. The command receipt projects `recovery-required` permanently (`pull-request-command-service.ts:72-75`).

**Expected vs observed:**
- Expected: reconciliation confirms whether the earlier (lost-ack) POST landed. The review with the matching operation marker at `commit_id === X` by `input.actor` is conclusive proof of delivery and is discoverable via bounded pagination → should return `acknowledged`.
- Observed: reconcile returns `unknown` solely because the *current* PR head differs from the operation's pinned head (or the PR is now closed/merged). The proven delivery is discarded and the operation is stuck `uncertain`/`recovery-required`.

**Impact:** A review that *was* successfully published is reported as `recovery-required` indefinitely and cannot self-heal. Only a manual `resolveOperation` (`application.ts:1506`, operator forcing `acknowledged`) clears it. This is false uncertainty for a confirmable delivery — not the intended "we genuinely cannot tell" uncertainty. It never causes a false acknowledgement or a double send (see negative controls), so the direction is safe, but liveness/recoverability regress.

**Parity regression:** the retained legacy path `operation-github.ts` `reconcile` (`operation-github.ts:58-77`) does **not** gate on current head or current actor — it fetches the review pages and matches on the review's own `commit_id`, `body` marker and `user.login`. So the extracted provider path introduced a stricter current-state gate that the legacy path never had. The R10 fix ledger explicitly chose to "recheck actor/head afterward"; this finding shows that rechecking *head* (and current *actor*) is logically unnecessary for reconciliation and harmful, because the found review's own `commit_id`/`user.login` already establish who delivered what and to which commit.

**Execution evidence (probe passes, demonstrating the defect):**
`/private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/claude_integrations/reconcile-head-recheck.test.ts`
- Control: with the current head unchanged, reconcile finds the receipt and returns `acknowledged` (`reviewId 4242`).
- Defect: with only the current head changed to `Y` (same review still present on page 1), reconcile returns `unknown`, and stays `unknown` on a repeated call.
- Defect: with the PR merged/closed (head still `X`), reconcile returns `unknown`.

**Reproduction:**
```
cd /private/tmp/helmsman-adversarial2-20260921-e3ccca4/claude_integrations
cp /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/claude_integrations/reconcile-head-recheck.test.ts ./zzprobe.test.ts
npx vitest run --config ./vitest.config.ts ./zzprobe.test.ts; rm -f ./zzprobe.test.ts
# 3 passed — control acknowledges, both head-moved / merged cases refuse the proven receipt
```
The shipped test `src/plugins/github/provider.test.ts:53-57` (`rechecks %s after reading the full history`) asserts the `unknown` result as *correct*, which is exactly the edge case that hides this: it changes the actor/head but does not assert that a matching, delivered receipt is thereby being discarded.

**Minimal fix direction:** In `reconcileReview`, do not require the *current* PR head/actor to equal the pinned values. Read the bounded history and require exactly one review whose own `commit_id === input.headSha`, `body === expectedBody`, and `user.login === input.actor` (already implemented at `provider.ts:289-297`). That match is sufficient proof of the past delivery. Drop the `prepared()` head/state/actor gates on the reconcile path (or make a head/state mismatch non-fatal so a found receipt still acknowledges), matching the legacy path's behavior. Keep them on `invokeReview`, where refusing to POST to a moved head is correct.

---

## Independent verification of the prior R10 fix (bounded pagination + exact reconciliation)

The core pagination/matching hardening is sound. I verified by inspection and by exercising the shipped tests (`21 passed`) plus my own adversarial probe:

- **Second-page receipt is found** (with and without a `rel="next"` link) — `provider.ts:32-47,57-85`; test `provider.test.ts:34-38`. Confirmed by my control case too.
- **Duplicate marker, duplicate id across pages, malformed page, failed page, foreign next-link, repeated-page** all yield `unknown` — `provider.test.ts:40-45`. The `ids` set (`provider.ts:288-292`) rejects cross-page id reuse; `nextPage` (`provider.ts:32-47`) rejects foreign origin, wrong path, wrong `page`, extra params, or a second `next` entry.
- **20-page bound** returns partial/`unknown` even when a matching marker sits within the bounded window — `provider.test.ts:47-51`.
- **Cancellation** stops pagination without acknowledging or sending — `provider.test.ts:59-64`; `request()` calls `signal.throwIfAborted()` before and after each call (`provider.ts:49-55`).
- **Completeness cannot be faked into a false ack:** for the non-keyed reviews collection, `quality:'complete'` requires reaching a short (<100) page with no `next` link; a marker on an unfetched page → `found.length===0` → `unknown`. Because the marker embeds the unique `operation.id:contentHash` (`pull-request-provider.ts:45-47`) and enqueue dedupes logical operations by id (`operations.ts:219-238`), a matching review can only exist if *this* operation's invoke posted it — so `acknowledged` is always truthful.

## Negative controls (attempts to disprove worse findings)

- **False acknowledgement:** Not reproducible. The receipt match keys on the per-operation marker; two distinct operations cannot share `id`+`contentHash`. A duplicate marker across pages → `found.length>1` → `unknown` (`provider.ts:297`). Confirmed via `duplicate-marker`/`duplicate-id` probe cases.
- **Auto double-send:** Not reproducible (static + state-machine reasoning). `markInvoked` runs once per generation, sets `requiresReconciliation=1` before the effect, and future leases take the reconcile path only (`operation-dispatcher.ts:45,52-54`; `operations.ts:279-287,310-313`). Slack `reconcileReviewRequest` (`slack/provider.ts:64-68`) and the PR reconcile never POST (the effects layer throws on any POST during reconcile — `pull-request-provider-effects.ts:140-141`, `communication-provider-effects.ts:185-186`). A lost ack yields at most `unknown`, never a second send.
- **Webhook mutation exemption (R02 boundary):** `allowMutationRequest` (`request-origin.ts`) exempts only `POST /api/webhooks/github`; `webhooks.ts:91-100` verifies an HMAC-SHA256 signature with `timingSafeEqual` over the raw body (64-hex required) *before* any dedup/state work, caps payload at 1 MB, and rejects delivery-id reuse with a different digest (409). Unauthenticated intake cannot mutate state.
- **Cross-caller / cross-repo isolation:** operation key is `public-review:hash(caller,requestId)`; `find()` re-verifies `caller` and `repo` else 404 (`pull-request-command-service.ts:84-91`); `clarificationScope` enforces configured/scope repo membership (`clarification-service-common.ts:19-26`); clarification cursors are HMAC-signed and binding-bound (`:32-56`). No cross-work leakage found.
- **Slack lost-ack:** `reconcileReviewRequest` deliberately returns `unknown` ("automatic resend is prohibited") — safe by design, matches the prior review's documented policy.
- **PR inspection head races:** `detail`/`diff` re-read metadata and throw `head-changed` if the target moved (`provider.ts:243,250,266`); reviews are marked partial if `updatedAt` changed between reads (`provider.ts:246`). No stale publication observed.

## Secondary / improvement ideas (not counted as defects)

- **Rate-limit classification (known, low-priority):** `invokeReview` maps any 4xx to `definitely-not-applied` with `retryable` only for 429 (`provider.ts:276-278`); the same holds in `operation-github.ts:29-33`. GitHub secondary rate limits arrive as 403 (often with `Retry-After`), so a rate-limited review post becomes permanently `blocked` needing operator retry. Accurate (the POST was not applied) but suboptimal resilience — already listed in the prior report.
- **Body round-trip fragility (static concern):** reconcile matches on exact `value.body === expectedBody`. If GitHub ever normalizes the stored body (line endings, trailing whitespace, Unicode) the marker match fails and the operation is stuck `unknown` even with head unchanged — compounding I1. Consider matching on marker substring (as the legacy path does with `body.includes(marker)`, `operation-github.ts:67`) rather than full-body equality.
- **Copilot reconcile ambiguity (legacy path):** `createCopilotOperationAdapter.reconcile` (`operation-github.ts:147-152`) acknowledges purely on the reviewer being currently in `requested_reviewers`, which a third party could have set and which Copilot consumes on review — a possible false-positive/false-negative for a *distinct* operation. Bounded to the legacy `github.copilot-review` kind; worth documenting the idempotency intent.

## Areas / history inspected

- `src/plugins/github/provider.ts` (full), diffed vs `ec3dd6b` — pagination generalization + reconcile rewrite are the only functional changes.
- `server/helmsman/pull-request-provider-effects.ts`, `pull-request-command-service.ts`, `operation-dispatcher.ts`, `operations.ts` — invoke/reconcile wiring, marker binding, double-send/idempotency state machine.
- `server/helmsman/operation-github.ts` (legacy manual-review + copilot), `manual-review-effects.ts`, `legacy-run-effects.ts` — parity comparison.
- `src/plugins/slack/provider.ts`, `server/helmsman/communication-provider-effects.ts` — Slack delivery/reconcile, `beforeSend` fence.
- `server/helmsman/webhooks.ts`, `request-origin.ts` — webhook signature + mutation guard exemption.
- `server/helmsman/clarification-service-common.ts` — scope/cursor isolation.

## Tests actually executed

- `npx vitest run src/plugins/github/provider.test.ts` → **21 passed** (baseline behavior confirmed, including the head-recheck test that masks I1).
- Probe `reconcile-head-recheck.test.ts` (copied into worktree, run, removed) → **3 passed**, proving I1 (control acknowledges; head-moved and merged cases refuse the proven receipt).

## Explicit gaps / limits

- No live GitHub/Slack/network effects; all HTTP was mocked via the provider context or vitest mocks. cmux/native-provider seams were inspected only where they touch communication browser transport; I did not exercise a live browser session.
- Double-send/idempotency was verified statically against the durable state machine, not by a running end-to-end store; a store-level probe was out of my budget and root owns aggregate runs.
- The I1 window requires a lost-ack followed by a head move/merge before reconcile; I proved the provider-level behavior deterministically but did not stage the full crash-restart timing in the durable layer.
- Windows-only paths, real GitHub body normalization, and very large (>2000) review histories were not exercised.

_Helmsman · claude-opus-4-8 - not reported_

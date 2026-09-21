# Phase E3: remaining feature packages

Status: design audit complete; implementation follows the E2 Helm cutover commit. This is part of Phase E, not completion of the full architecture plan.

## Task presentation first

Extract Todos through source-qualified reads and durable commands before moving Triage, Bugs and source administration. The current generic source-command endpoint returns private local records and lacks durable rejection receipts; it is not a public browser contract. Existing Todo mutation identities remain on their legacy compatibility path until reconciled. Never reinterpret a saved request against a new source revision or caller.

Use composition pages with stateful panels for feature drafts, reusing revision-checked IndexedDB layout state. Add public initial-layout declarations for new composition records rather than hardcoding feature defaults in the host. Existing records, including deliberately empty layouts, must remain unchanged. Generalize page-slot navigation while retaining core Config and Recovery.

| Boundary | Required behavior |
|---|---|
| `helmsman/task-edit@1` | Load a source-qualified editor envelope with canonical WorkRef, exact record/source revisions, declared editor contract, bounded public value, and explicit editability. Providers opt in; ordinary lists reuse task reads without loading every editor document. Never expose claims, bindings, credential handles or raw storage records. |
| `helmsman/source-command@1` | Host-reserved durable request IDs, immutable caller/source selection/input, receipt lookup, pending recovery and explicit acknowledgment. Resolve recorded receipts before current enablement gates. Preserve terminal results through disablement/adoption. Commands remain constrained by declared provider handlers, expected record revision, scope and active-claim ownership. |
| Triage provider view | Independent results for unassigned backlog, unassigned ready work and assigned open work. Provider-owned project/status/assignee semantics, canonical task identity, real update timestamps, filters before bounded pagination, explicit partial/unavailable groups. Do not substitute ordinary queue JQL. |
| Bugs provider view | Provider-owned issue type, severity and query policy. Source-qualified rows, nullable metrics, per-metric coverage/approximation and actual SLA dates. Errors never become zero counts. |
| `helmsman/source-admin@1` | Redacted configuration, revision-checked changes, explicit galleon scheduling, adoption/refresh validation and pinned commit receipts. Source-wide administrative changes remain distinct from task-scoped commands. No credential values in public DTOs. |

The first mutation implementation must retain one logical command through response loss and concurrent tabs. Project a confirmed result as canonical task identity/revision or deletion, not a raw `LocalSourceRecord`. Prepare outside the transaction; share the actual local-record transition and durable success receipt transaction, or reconcile their recorded immutable linkage before retrying. Definite rejections are durable; uncertain work cannot be dismissed as a rejection. Acknowledge only after consuming the result and saving the affected draft.

Acceptance includes editing during refresh/scope changes, stale record revisions, active claim locks, destination-galleon scope, response loss, terminal receipts after disable/adoption, same-intent deduplication across tabs, provider replacement, explicit unavailable metrics, and standalone SDK installation/reload.

## Run presentation and clarifications

The public run service already supplies worker outcomes, attempts, measured cost, review verdicts and separate source settlement. Extend it narrowly for permitted-scope legacy run-ID resolution, truthful history pagination metadata, bounded backward log preview, attempt-bound log cursors and watermark-bound streaming export. Add typed run/PR presentation locators rather than leaking internal route or client objects.

The legacy drawer is shared by Runs, PRs, Triage and Todos. One authored viewer must own its tabs, subscriptions, logs, clipboard/export, drafts and commands. A temporary generic mounting adapter may rehome that viewer across remaining legacy consumers; page-only extraction cannot claim the drawer owner has been removed. Keep one viewer session and suspend hidden/out-of-scope subscriptions. Core Recovery remains available with optional presentation disabled.

Clarification reads need bounded scoped DTOs. Answers require host-reserved request identity and an atomic answer-transition/receipt transaction, preserving exact question/run binding, pending state, running worker and deadline checks. Suggested-contact management is explicitly global and separate; saving a contact never sends a message. Core retains question ingestion, timeout/cancellation, answer delivery and required-answer publication gates. Preserve unfinished answers and independent contact-read failures.

Do not add a browser Resume action as part of extraction. Existing continuation keeps a run ID and increments its attempt; it cannot use the current launch/retry protocol, which creates a new run at attempt 1. Any later Resume contract must preserve checkpoint/artifact/claim/worktree verification, unresolved effects, capacity and budgets.

## Subsequent batches and ownership

PR details, human review and communication need their own typed reads and durable effect ports before embedded PR controls move. Terminal and campaign presentation follow their scoped session/coordinator ports. Feature settings move into namespaced contributions. Execution policies awaiting replacement protocols remain explicitly tracked until Phase F; Phase G removes those adapters only after independent implementation proof.

Root owns page composition defaults, navigation/slot generalization and central service wiring. The backend owner implements durable source commands and editor reads. The provider owner implements Triage/Bugs contracts and provider views. The presentation owner implements standalone Todos and source-settings packages after contract agreement. Each slice requires independent review, focused tests, TypeScript/build, browser/visual and source-denied production evidence before cutover.

_Helmsman · not reported - not reported_

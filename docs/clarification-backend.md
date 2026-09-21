# Clarification services and durable admission

The E4 service implementation exposes bounded question reads, durable answers and explicitly global suggested-contact administration. Presentation acceptance and remaining compatibility retirement are tracked separately in the [E4 plan](plugin-phase-e4-implementation.md) and [completion ledger](plugin-implementation-progress.md). These services do not deliver answers to workers or send messages to contacts.

## Initialization and authority

Create `openClarificationReceiptStore(persistence)` after the compatibility clarification store and its protocol metadata, before acquiring the application writer lease. The new owner is `core.public-clarification-receipts@1`; it owns `public_clarification_receipts`, `public_suggested_contact_receipts` and the listing indexes. The published `compat.clarifications@1` and `core.clarification-protocol@1` definitions and checksums remain unchanged.

`createClarificationReadService` and `createClarificationCommandService` receive the shared persistence connection, clarification protocol, execution store, persisted execution controls, configured galleons and a contribution authorizer. All supplied stores must use that same SQLite connection. The command service also receives the receipt store and checks its connection identity. `createSuggestedContactAdminService` receives persistence, receipts and the authorizer; it does not inherit a galleon scope.

The application authorizer requires an enabled, recognized page or panel contribution declaring the matching version-1 service. Safe start denies service access. Caller authorization and configured/effective scope checks precede receipt lookup; exact receipt replay bypasses current question eligibility, not contribution or scope authority. Disabling a package preserves server receipts and browser journals. Reenable the same contribution and restore its authorized galleon scope to reconcile its original request. This slice adds no operator command for adopting another contribution's journal or receipts.

## HTTP contract

Every request carries `X-Helmsman-Contribution`. Successful HTTP responses contain the public DTO or a null missing receipt; browser adapters construct the `available`/`unavailable` envelope. Errors contain only `{ reason }`, with bounded public reasons. Validation errors are 400, missing identities 404, denied contributions/scopes 403, cursor/request conflicts 409 and unavailable internal state 503. Duplicate query parameters are rejected.

| Operation | Route and body/query |
|---|---|
| Question list | `GET /api/clarification-read` with nullable `repo`, `runId`, JSON `states`, `limit`, optional `cursor`, and effective `scopeRepo` |
| Exact question | `GET /api/clarification-read/:questionId` with `repo`, `runId`, effective `scopeRepo` |
| Answer | `POST /api/clarification-command` with `{ command, scopeRepo }` |
| Answer receipt | `GET /api/clarification-command/receipts/:requestId` with `repo`, effective `scopeRepo` |
| Contact list | `GET /api/suggested-contact-admin?scope=global` with `limit`, optional `cursor` |
| Exact contact | `GET /api/suggested-contact-admin/:id?scope=global` |
| Contact command | `POST /api/suggested-contact-admin/commands` with the complete global command |
| Contact receipt | `GET /api/suggested-contact-admin/receipts/:requestId?scope=global` |

Null query values are omitted. Contact commands include explicit `scope: 'global'`. Host-reserved command IDs and create-contact IDs are UUIDv4 values. Existing contact IDs retain their original case and the compatibility identifier syntax.

Question list/count queries share one database observation. `total` counts the full scoped/filter-matched collection before the keyset boundary. Pages are ordered by creation time and ID, descending. Signed cursors bind caller, effective scope, configured galleons, filters and service lifetime; restart invalidates them. Membership and state may change between observations. Question pages contain at most 100 rows and remain within the public 2 MiB JSON response budget, reducing page length when escaped prompt/answer text is large without clipping fields. Contact pages contain at most 100 rows and preserve full metadata.

Question reads expose durable provenance, revision, current attempt and observed answerability. They do not expose channel paths or gate credentials. `blocksPublication` remains true for every required question whose state is not answered, including unknown, prior-attempt, cancelled and timed-out obligations. Missing channel/snapshot evidence denies answering without hiding the question. Contact availability is independent of question reads and answers.

## Atomic answer transaction

After caller/scope/payload validation, admission uses the shared synchronous `BEGIN IMMEDIATE` transaction:

1. Look up the caller/request receipt. Identical canonical input returns its recorded outcome; changed input conflicts. This precedes current deadline, attempt, stop and run-state checks.
2. Load the exact galleon/run/question, trigger-maintained revision and channel provenance. Validate the retained execution snapshot and channel against the current attempt, and read its persisted stop intent on the same connection.
3. Require the requested attempt/channel/revision, pending state, active run and unexpired deadline. Unknown provenance remains read-only.
4. Compare-and-set the answer with its exact metadata revision and identity. The revision trigger runs inside this transaction. Store the success receipt with the canonical answer, resulting revision and acceptance time.
5. On a definite rejection, store a terminal rejection receipt. An expired pending question becomes timed-out; a pending question with a missing/inactive run becomes cancelled. Those lifecycle changes commit with the rejection receipt. Prior-attempt or unknown questions are not reassigned.

Receipt failure rolls back answer, revision and any lifecycle transition. No asynchronous work, filesystem polling or worker delivery occurs inside admission. A successful receipt proves durable acceptance only. Core runtime polling separately publishes matching channel answers; [recovery guidance](recovery.md#clarification-channels-and-unresolved-questions) describes terminal file validation.

## Atomic contact transaction

The browser reserves a contact UUID and request UUID before creating. An exact caller/request replay returns the prior result without inserting a second row. A new create whose contact ID already exists records a conflict. Updates require the exact current contact revision and preserve `createdAt`; metadata, trigger-maintained revision and receipt commit together. Names and addresses preserve compatibility semantics: trimmed, nonempty text with limits of 160 and 320 UTF-16 code units. Addresses are not restricted to email. `enabled` is always explicit.

Distinct callers may deliberately create contacts with the same metadata under different IDs. Contact save has no messaging dependency or external effect. Receipt failure rolls the contact mutation back.

## Compatibility boundary and verification

While public services are active, the application returns 410 for the legacy unverified `POST /api/clarifications`, ID-only `POST /api/clarifications/:id/answer` and `POST /api/trusted-contacts` paths. Retaining any of those as unrestricted writes would bypass the new identity/revision/receipt rules. Trusted in-process channel ingestion and lifecycle processing remain core responsibilities. Legacy GETs remain temporarily while fully authored clarification presentation and final compatibility retirement are pending.

Service tests cover scoped reads and truthful totals, cursor rebinding/restart, full escaped text under the byte budget, unknown/prior obligations, missing channel evidence, persisted stop, expiry/inactive-run transitions, exact replay after restart and changed eligibility, and receipt integrity. Two concurrent Node processes contend on the same SQLite answer transaction and produce one acceptance plus one durable stale-revision rejection. Fault injection verifies answer, lifecycle and contact rollback when receipt writes fail. Route tests verify methods, payloads, caller identity and sanitized failures. Contact tests cover UUID retention, legacy IDs, stale updates, preserved creation time and independent question operation during contact failure.

_Helmsman · not reported - not reported_

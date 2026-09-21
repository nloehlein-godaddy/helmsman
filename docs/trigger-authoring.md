# Trigger authoring

Trigger plugins make narrow decisions over bounded observations supplied by Helmsman. They do not own polling loops, credentials, queues, run IDs, claims, launch callbacks, or publication. A backend-only package declares `helmsman/trigger@1` and registers each local contribution through `registerTrigger`.

Trigger packages may provide only trigger capabilities. The declaration access must match the provider kind:

- Campaign providers use `campaign-candidates`.
- Communication and pull-request review watchers use `review-discovery`.
- Webhook parsers use `authenticated-event`.

The activation context contains only the plugin ID, validated nonsecret settings, an abort signal, registration, and disposal. Put enablement, polling intervals, filters, and route mappings in package settings. Helmsman persists settings and captures the exact provider artifact and settings used for each accepted proposal.

## Campaign selection

A `CampaignTriggerProviderV1` synchronously chooses one opaque `candidateId` from `CampaignTriggerInputV1` or returns `null`. The candidates have already passed core phase ordering, concurrency, repository, capacity, and duplicate-run checks. A provider may prioritize or defer them, but it cannot rewrite a task, repository, attempt, workflow, or launch identity.

Use only the current input. Do not retain a cursor or mark work claimed. Helmsman reloads and revalidates the chosen candidate, records provenance with the existing claim transaction, and rebuilds the snapshot after every claim.

Candidate projection uses the same campaign concurrency and galleon exclusion checks as the atomic claim. A rejected claim is skipped for the remainder of that poll so it cannot block other eligible campaigns.

## Review discovery

A review watcher declares either `source: 'communication'` or `source: 'pull-request'`. That discriminator controls its invocation context.

Communication watchers can read scoped messages and exact pull-request details. Proposal `eventId` values must come from observed messages, and `targetId` values must come from details returned during the same invocation. Return a timestamp cursor only after a complete scan. When a required detail is unavailable or the message scan is incomplete, return `complete: false` without advancing the cursor.

Pull-request watchers can read the selected provider's requested-review list and exact details. Their proposals use `eventId: null` and `nextCursor: null`. Partial, degraded, or truncated list results are incomplete. Filter closed, merged, and draft pull requests, and never infer a head SHA from a list item; only detail results carry the exact target revision.

Core records requested-review membership separately from policy proposals. Queued reviews require positive membership in the current scan before a new admission. A complete source list retires removed requests; partial or failed scans preserve unobserved requests without launching them. Replacement policy filters govern new proposals and do not cancel a retained decision for a request still present. Existing-run receipts reconcile even while intake is disabled.

Current validated detail retires a retained decision when its head is superseded or the pull request is closed, merged, or draft. Null, failed, malformed, mismatched, or stale-source responses preserve the queued decision and its artifact pins. Retirement does not wait for execution capacity.

Check `context.signal` around every asynchronous read and stop promptly when aborted. Helmsman also validates observed handles, bounds reads and output, fences selection and source revisions, deduplicates events, rechecks the exact pull-request head before dispatch, and owns cursor persistence.

## Authenticated webhooks

A `WebhookTriggerProviderV1` declares lowercase signature, delivery, and event header names plus the supported HMAC format. Helmsman reads bounded raw bytes, retrieves the core-owned secret, authenticates the signature, validates the delivery identity, detects conflicting duplicates, and parses generic JSON before calling the provider.

The provider receives only the delivery ID, event name, and parsed `PluginJson` body. It returns one normalized workflow intent or `null` for an ignored event. Validate configured routes, event, action, repository, and entity fields. Do not accept secrets, signatures, credential handles, raw requests, or headers in settings or provider input.

Helmsman persists ignored and accepted deliveries with their digest and captured parser provenance. A settings or provider replacement cannot reinterpret a duplicate delivery.

## Lifecycle and safety

Selected trigger roles are independent: campaign, Slack review, GitHub review, and GitHub webhook. Disabling one package or setting stops new decisions from that provider while existing queued receipts and reconciliation remain core-owned. A disabled provider should return no choice or proposals and must not advance a cursor or perform scoped reads.

Provider methods receive validated immutable projections. Keep synchronous decisions pure and asynchronous scans read-only. Do not import Helmsman server files or another plugin package. Do not use timers, mutable module state, plugin storage, network clients, process environment, Git, random run IDs, or private transport APIs.

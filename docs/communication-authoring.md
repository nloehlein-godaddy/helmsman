# Communication authoring

Helmsman exposes communication presentation and delivery through public version 1 contracts. The shipped `helmsman.communication` frontend is an independently buildable notification header and composition page. Its notifications, review-request, and settings panels use only `@helmsman/plugin-sdk`. The shipped `helmsman.slack` backend is an independently buildable `helmsman/communication@1` provider. Neither package imports application source.

The `/communication` alias selects the `helmsman/communication-page` slot. The notification control selects `helmsman/notification-header`. The page accepts `helmsman/communication-panel@1` contributions and starts with separate notification, review-request, and settings instances. Layouts are authoritative: disabling or replacing a selected contribution leaves it unavailable without falling back, and existing empty, hidden, copied, or missing-panel layouts are preserved.

Select independently installed contributions with the plugin CLI:

```sh
node /absolute/path/to/release/server/helmsman/plugins/cli.js select helmsman/communication-page example.communication/page
node /absolute/path/to/release/server/helmsman/plugins/cli.js select helmsman/notification-header example.communication/header
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-communication example.slack/slack
```

`select-communication default` clears the explicit backend binding. An explicitly selected disabled or unavailable provider does not fall back to another provider. Restart Helmsman and reload browser tabs after backend activation or selection changes.

## Public frontend services

Contributions declare `helmsman/communication@1` for reads and settings. `CommunicationServiceV1` provides:

- `notifications({ version: 1, repo, limit })`, with a limit from 1 through `COMMUNICATION_LIMITS.notifications` (256), returning bounded notifications, independent Slack and GitHub health, result quality, and an unread count;
- `markRead({ repo, id })`, scoped to the notification's galleon;
- `settings()`, returning the global communication values, current displayed destination, and a revision; and
- `saveSettings({ expectedRevision, values })`, which conditionally replaces the global values.

Core authorizes the mounted contribution and intersects notification reads with its captured galleon scope. It projects only notifications for permitted galleons. The unread count covers the permitted result before the requested display limit, so pagination does not understate it. A caller cannot mark a notification from another galleon. Settings are global, but access still requires a valid captured scope and declared service requirement.

The settings revision covers both the values and resolved destination. A concurrent values, provider, artifact, or destination change causes a conflict. The settings panel keeps its draft for explicit reconciliation. Empty unconfigured fields are valid. Saving settings only writes settings; it never reserves or invokes a communication command and never sends a message.

Hidden notification panels pause polling and abort their scoped reads. Explicit mark-read work has its own lifecycle so an ordinary polling refresh does not cancel it. Disposal and scope changes cancel active work. Unavailable services, invalid responses, and forbidden scopes render unavailable state without substituting legacy data.

## Durable review requests

Review-request contributions also declare `helmsman/communication-command@1`. A new command contains the exact galleon, PR number, and displayed `expectedDestination`. The destination includes provider contribution, artifact hash, workspace, channel, mention, and connection ID. The panel displays that destination before enabling Send.

The browser journal is namespaced by the mounted contribution identity. It reserves a UUID and the complete input before transport. Copies or renamed packages therefore receive separate journals; they do not import, acknowledge, or replay another contribution's requests. Changed PR or destination data cannot reuse an unresolved request. A lost browser response retains the original request across reload and exposes receipt lookup or exact retry. Retry reads the retained journal entry and sends that exact command; a missing or already acknowledged entry sends nothing.

Core admits a request only when the PR is open, unmerged, and owned by the configured GitHub author. It rejects a recent legacy Slack request for the same PR and enforces the public-command cooldown for the same PR and destination across callers, even when callers reuse a UUID. Admission resolves the currently selected provider, verifies its retained artifact, and confirms that the displayed destination still matches current settings. It then commits an operation with the caller, request, command, destination, provider binding, and artifact before allowing the external send.

The provider receipt reports workspace, channel, mention, connection, and an optional permalink. Core projects the retained repo, number, and destination into the public receipt; a provider cannot rebind them. A terminal result is saved by the panel before journal acknowledgment. Pending and recovery-required commands retain their original destination, provider binding, artifact, and request identity after settings changes, disablement, restart, or replacement.

An uncertain Slack send cannot be proven by finding the same or another PR URL in channel history. The URL is not the retained request identity, and another author or request can post identical text. Reconciliation must return an exact retained provider receipt. The shipped Slack provider has no durable exact receipt after an uncertain browser send, so it reports unknown and prohibits automatic resend. Keep the request in Core Recovery until exact evidence or an operator resolution is available.

## Backend provider contract

A backend package declares `helmsman/communication@1`, a matching `communications` entry with `browser-session` access, and registers it during activation:

```ts
import type { CommunicationProviderV1, PluginBackendModule } from '@helmsman/plugin-sdk';

const provider: CommunicationProviderV1 = {
  async prepareReviewRequest(input, context) {
    return context.destination;
  },
  async invokeReviewRequest(input, context) {
    await context.beforeSend();
    return { status: 'unknown', reason: 'No receipt was recorded.', evidence: {} };
  },
  async reconcileReviewRequest(input, context) {
    return { status: 'unknown', reason: 'No exact receipt is available.', evidence: {} };
  },
  async scanReviewRequests(input, context) {
    return { messages: [], complete: true };
  },
};

const backend: PluginBackendModule = {
  activate(context) {
    context.registerCommunication('provider', provider);
  },
};

export default backend;
```

Preparation is read-only and must return the supplied workspace, channel, mention, and connection. `invokeReviewRequest` must call `context.beforeSend()` immediately before the external mutation. That call rechecks the durable lease, selected binding, settings, connection, and destination. Reconciliation is read-only; its context rejects sends. Results are limited to `acknowledged` with an exact receipt, `definitely-not-applied` with evidence and retryability, or `unknown` with evidence.

`scanReviewRequests` returns bounded channel messages and PR URLs for the incoming notification watcher. Scanning cannot send. Core validates the configured channel, timestamps, Slack permalinks, completeness, and settings stability before accepting a scan.

Core currently owns the bounded browser execution adapter: tree discovery, focus, evaluation, click, fill, and wait. It guards the retained Slack workspace and surface, validates arguments, applies timeouts and cancellation, and serializes access. The Slack package owns Slack DOM inspection, channel and user-group resolution, draft policy, exact message construction, send timing, receipt recognition, focus restoration, and scan policy. Replacing the browser execution primitive belongs to Phase F; provider policy and Slack DOM knowledge do not move into core.

## Disablement, recovery, and legacy operations

Disabling frontend contributions disposes their panels while retaining layouts, drafts, results, and caller journals. Disabling or replacing the selected backend denies new communication admission. A provider artifact retained by an existing operation remains eligible only for obligation resolution; uninstall and artifact collection cannot remove pinned bytes.

Core Recovery dispatches public communication operations through their retained resolver. Older `slack.review-request` operations also retain their legacy resolver so existing obligations remain recoverable. The active authored flow does not admit new legacy operations. Safe start activates neither optional provider nor reconciliation; restart normally to resolve obligations.

## Independent build and acceptance

The distribution ships `release/plugin-sources/communication` and `release/plugin-sources/slack`. Copy either directory outside the checkout, install the copied SDK and TypeScript, and run its build. Pack the resulting `dist` directory through the compiled CLI. Rename reserved `helmsman.*` frontend package IDs and their self-referencing initial-layout contribution IDs before installing an external copy. A backend copy also needs a nonreserved package/provider ID.

The communication production gate denies access to application source, compiles and installs the frontend and backend packages against only the distributed SDK, selects both frontend slots and a communication provider, and runs the real server. It covers lost browser responses without duplicate delivery, retained receipts, settings conflicts, desktop/mobile rendering, provider disablement, restart, and selected-page unavailability. This proves standalone frontend and backend builds through the public contracts; it does not turn trusted plugin code into a sandbox.

Review delivery requires the workspace and review destination; watcher channel fields are required only for scans. Proven failures before a send block unattended delivery under the retained operation; only the explicit retry command reopens delivery. Host command policy disables automatic operation retry even when a provider marks such a failure retryable. Failures after an attempted send remain uncertain and never authorize automatic replay. Historical success receipts remain available; preparing another request is an explicit presentation action and sends nothing until the user presses Send again. The server still enforces its cooldown.

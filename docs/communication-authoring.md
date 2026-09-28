# Communication authoring

Helmsman exposes communication presentation and delivery through public version 1 contracts. The shipped `helmsman.communication` frontend is an independently buildable notification header and composition page. Its notifications, review-request, and settings panels use only `@helmsman/plugin-sdk`. The default `helmsman.slack-companion/slack` backend is an independently buildable `helmsman/communication@1` provider using the Slack MCP service behind GoCaaS/OI Companion. `helmsman.slack-oi/slack` is an opt-in OI-hosted Companion provider; `helmsman.slack/slack` remains an opt-in legacy browser provider. These packages do not import application source.

The `/communication` alias selects the `helmsman/communication-page` slot. The notification control selects `helmsman/notification-header`. The page accepts `helmsman/communication-panel@1` contributions and starts with separate notification, review-request, and settings instances. Layouts are authoritative: disabling or replacing a selected contribution leaves it unavailable without falling back, and existing empty, hidden, copied, or missing-panel layouts are preserved.

Select independently installed contributions with the plugin CLI:

```sh
node /absolute/path/to/release/server/helmsman/plugins/cli.js select helmsman/communication-page example.communication/page
node /absolute/path/to/release/server/helmsman/plugins/cli.js select helmsman/notification-header example.communication/header
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-communication example.slack/slack
```

`select-communication default` clears the explicit backend binding and uses Companion. An explicitly selected disabled or unavailable provider does not fall back to another provider. Restart Helmsman and reload browser tabs after backend activation or selection changes.

## Companion connection

The production endpoint is `https://mcp-slack.goarena.gdcorp.tools/mcp`; the test
endpoint is `https://mcp-slack-test.goarena.gdcorp.tools/mcp`. Override the endpoint
with `SLACK_MCP_URL` and supply a user-delegated Slack OAuth token through
`SLACK_MCP_TOKEN` in the secure server environment. Restart after credential or
endpoint changes. This token is distinct from `GOCAAS_API_KEY`; model routing does
not authenticate Slack. Credentials never enter UI values, plugin settings, or
retained public destination evidence.

The service expects the delegated token. Helmsman does not initiate OI's OAuth flow,
use metadata discovery, extract browser sessions, or fall back to the browser when
a credential fails. See the [Companion overview](https://godaddy-corp.atlassian.net/wiki/spaces/xform/pages/4509107536/Slack+GoCaaS+OI+Companion+Overview).

Set `SLACK_CLIENT_ID` to the Slack workspace ID and configure watched channel ID and
name for scans. For outgoing requests, set `SLACK_REVIEW_CHANNEL` to a channel ID beginning with `C`
or `G` and set `SLACK_REVIEW_MENTION` to a Slack user group ID beginning with `S`. Companion cannot
resolve group handles, so retained legacy defaults must be replaced before sending.
The watcher can operate without a review group. `SLACK_BROWSER_SURFACE` is ignored
by Companion and remains relevant only to the explicitly selected legacy provider.

Reads can run automatically through the selected review trigger. Posting remains an
explicit user action after durable command admission. Helmsman uses no reaction or
delete tools. An absent or rejected credential makes the source unavailable.

The one-time upgrade replaces a prior shipped `helmsman.slack/slack` selection with
Companion while preserving custom selections. Operators can explicitly reselect the
legacy provider after migration; later restarts preserve that choice. Pending browser
operations retain their original binding and artifact.

## Optional account connection

`CommunicationProviderV1.connection` is an optional SDK extension with status,
begin, complete, disconnect, and check methods. Existing providers remain valid
without it. Core exposes the selected provider through optional
`CommunicationServiceV1` account methods, including when no credentials exist.
Account actions carry the displayed provider revision; replacement or disablement
invalidates it. The host binds a one-use OAuth state to the initiating browser and
selected artifact. Providers must invoke the completion authority fence immediately
before storing credentials, in addition to fencing their own concurrent grant
changes. Short-lived cookies remain after callbacks so older responses cannot
clear a newer authorization; consumed states cannot be replayed.

The direct Slack MCP plugin owns authorization, refresh, account checks, private
credential storage, and its exact three Slack user scopes. Core handles caller
permissions, callback dispatch, HTTPS-origin checks, and selected-provider lifetime.
No credential crosses the public SDK snapshot, settings draft, or operation receipt.
The connection controls do not send Slack messages. The configured app and HTTPS
callback are operator prerequisites; OI authentication is independent.

## OI Slack Companion

The opt-in `helmsman.slack-oi/slack` provider reuses the user's Slack authorization
in OI through the hosted `godaddy-slack-companion` model. It needs no separate
Helmsman Slack application or exported Slack OAuth token. Personal Slack consent
inside OI is still required. Existing default and explicit provider selections,
as well as retained requests, are unchanged.

**Current production limitation:** OI reports `enable_tool_permissions=false` in
`/api/config`. The provider fails closed before creating a chat task when native
tool approvals are disabled. Mocked integration tests demonstrate the supported
approval-enabled protocol; they do not demonstrate live production delivery.

Supply an OI credential through `SLACK_OI_TOKEN` or an absolute
`SLACK_OI_TOKEN_FILE` path to a user-owned file with mode `0600`. `SLACK_OI_AUTH_MODE` is `bearer` by default or `sso-jwt`;
`SLACK_OI_URL` defaults to `https://caas.open-webui.godaddy.com`. Also supply
`SLACK_OI_OAUTH_SESSION_ID`, the OI `oauth_session_id` cookie value needed to
retrieve your connected Slack authorization. Keep this session credential in the
secure server environment. Neither a Slack token nor `GOCAAS_API_KEY` is an OI credential. The provider does not extract browser cookies, refresh credentials or implement the OAuth flow. Credentials stay outside settings,
durable operations and public receipts. Restart after configuration changes.

Run `npm run slack:oi:check` for a read-only preflight. It checks the OI deployment
without starting inference or invoking Slack tools. When native approvals are
available, explicitly select `helmsman.slack-oi/slack` with
`helmsman plugins select-communication helmsman.slack-oi/slack`, then restart.
An independently built external package uses `example.slack-oi/slack` instead.
Workspace, channel and user group IDs use the same fields as direct MCP.

Preparation validates local credentials and destination fields without inference.
Invocation checks live readiness before creating any chat; unavailable approvals
produce a durable failure receipt with the actionable reason. Existing host policy
keeps that blocked request in Core Recovery; no Slack tool was invoked.
For each tool operation, the transport creates a saved OI chat, requests one tool and
polls for native approval. It approves only the exact expected tool name and
arguments. The send authorization fence runs immediately before approving
`send_message`; approval is the external write boundary. Only structured tool
results establish search data or a Slack delivery receipt. Assistant
prose cannot establish delivery. Unexpected calls remain unapproved; uncertain
post-approval failures never trigger an automatic resend.

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

An uncertain Slack send cannot be proven by finding the same or another PR URL in channel history. The URL is not the retained request identity, and another author or request can post identical text. Reconciliation must return an exact retained provider receipt. No shipped Slack provider can establish an exact receipt after an uncertain send without retained evidence, so it reports unknown and prohibits automatic resend. Keep the request in Core Recovery until exact evidence or an operator resolution is available.

## Backend provider contract

A backend package declares `helmsman/communication@1`, a matching `communications` entry with `provider-network` access for direct network delivery (or `browser-session` for legacy browser automation), and registers it during activation:

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

A network provider can implement optional `connectionIdentity()` to bind current endpoint and credential identity without exposing credentials. Connection changes invalidate new admission against an old displayed destination. Existing providers without that method retain their existing connection behavior. Declaring network access does not grant browser primitives. Plugins are trusted code, not a network sandbox.

Preparation is read-only and must return the supplied workspace, channel, mention, and connection. `invokeReviewRequest` must call `context.beforeSend()` immediately before the external mutation. That call rechecks the durable lease, selected binding, settings, connection, and destination. Reconciliation is read-only; its context rejects sends. Results are limited to `acknowledged` with an exact receipt, `definitely-not-applied` with evidence and retryability, or `unknown` with evidence.

Incoming automatic Slack reviews also require an authenticated ownership observation from the selected PR provider: `profile.login` must differ from the exact-head PR author. Own PRs are blocked; unavailable identity remains queued. Core captures and rechecks the provider, connection, source and trigger, and persists bounded policy evidence before dispatch. This differs from the configured-author eligibility of an explicit outgoing review request above. Legacy queue entries without retained proposal/provenance cannot bypass the check.

`scanReviewRequests` returns bounded channel messages and PR URLs to the separately selected `slack-review` trigger. Scanning cannot send. Core validates the configured channel, timestamps, Slack permalinks, completeness, and settings stability before accepting a scan.

Only the legacy `helmsman.slack/slack` provider uses a native browser host. The selected native browser provider supplies bounded tree discovery, focus, evaluation, click, fill, and wait primitives through core guards. Core guards the retained Slack workspace and surface, validates arguments, applies timeouts and cancellation, and serializes access. The Slack package owns Slack DOM inspection, channel and user-group resolution, draft policy, exact message construction, send timing, receipt recognition, focus restoration, and scan policy. Use `select-browser-host` to replace browser primitives independently of communication policy. The watch form displays read-only status; configure the selected review trigger for enablement, interval and filtering. `SLACK_WATCH_ENABLED` seeds trigger enablement once. Communication source enablement still independently controls reads. See [trigger authoring](trigger-authoring.md); trigger extraction is reviewed and pushed through `12a62c9`.

## Disablement, recovery, and legacy operations

Disabling frontend contributions disposes their panels while retaining layouts, drafts, results, and caller journals. Disabling or replacing the selected backend denies new communication admission. A provider artifact retained by an existing operation remains eligible only for obligation resolution; uninstall and artifact collection cannot remove pinned bytes.

Core Recovery dispatches public communication operations through their retained resolver. Older `slack.review-request` operations also retain their legacy resolver so existing obligations remain recoverable. The active authored flow does not admit new legacy operations. Safe start activates neither optional provider nor reconciliation; restart normally to resolve obligations.

## Independent build and acceptance

The distribution ships `release/plugin-sources/communication`, `release/plugin-sources/slack-companion`, `release/plugin-sources/slack-oi`, and the legacy `release/plugin-sources/slack`. Copy a directory outside the checkout, install the copied SDK and TypeScript, and run its build. Pack the resulting `dist` directory through the compiled CLI. Rename reserved `helmsman.*` frontend package IDs and their self-referencing initial-layout contribution IDs before installing an external copy. A backend copy also needs a nonreserved package/provider ID.

The communication production gate denies access to application source, compiles and installs the frontend and backend packages against only the distributed SDK, selects both frontend slots and a communication provider, and runs the real server. It covers lost browser responses without duplicate delivery, retained receipts, settings conflicts, desktop/mobile rendering, provider disablement, restart, and selected-page unavailability. This proves standalone frontend and backend builds through the public contracts; it does not turn trusted plugin code into a sandbox.

Review delivery requires the workspace and review destination; watcher channel fields are required only for scans. Proven failures before a send block unattended delivery under the retained operation; only the explicit retry command reopens delivery. Host command policy disables automatic operation retry even when a provider marks such a failure retryable. Failures after an attempted send remain uncertain and never authorize automatic replay. Historical success receipts remain available; preparing another request is an explicit presentation action and sends nothing until the user presses Send again. The server still enforces its cooldown.

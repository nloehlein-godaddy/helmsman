# Slack Companion communication provider

This SDK-only package implements Slack review requests and watched-channel discovery using GoDaddy's Slack MCP service behind the [Slack GoCaaS OI Companion](https://godaddy-corp.atlassian.net/wiki/spaces/xform/pages/4509107536/Slack+GoCaaS+OI+Companion+Overview). It needs no Firefox extension, browser session, or GoCaaS model request.

The bundled plugin is `helmsman.slack-companion`, with communication local ID `slack`. The standalone package descriptor uses `example.slack-companion`. It declares `provider-network` access and registers only through `@helmsman/plugin-sdk`.

## Configuration

Set `SLACK_MCP_TOKEN` in the Helmsman server environment to your **Slack user OAuth token**. A GoCaaS API key is not accepted by Slack MCP. Obtain the token through your organization's approved Slack authorization process. This direct-token mode does not refresh expired tokens. Token expiry requires replacing the environment credential and restarting the server. The optional app OAuth mode below provides connection and refresh management.

`SLACK_MCP_URL` defaults to `https://mcp-slack.goarena.gdcorp.tools/mcp`. The only alternative is the documented test endpoint, `https://mcp-slack-test.goarena.gdcorp.tools/mcp`. Redirects are rejected so credentials cannot be forwarded to another endpoint. Tokens are never stored in plugin settings, operation records, or response evidence. Connection identity is a SHA-256 digest of the endpoint and credential, so replacement invalidates old retained connections.

Select the Slack Companion communication provider. Configure the Slack workspace ID, review channel **ID** (`C…` or `G…`), and reviewer user group **ID** (`S…`). Channel names and user group handles cannot safely replace these identifiers: durable operations pin the exact channel, and the documented MCP service does not expose a user group lookup tool. The message uses Slack's `<!subteam^ID>` mention format. Watched-channel discovery uses its separately configured channel ID.

The token needs access to those channels and scopes sufficient for `conversations.info`, `chat.postMessage`, and `search.messages` (`search:read` is required for discovery). Slack enforces the caller's channel permissions. A token without search access can send reviews but cannot discover review requests.

## Optional Slack app OAuth

To connect through your own approved Slack app, configure these server environment values and restart Helmsman:

- `SLACK_OAUTH_CLIENT_ID` and `SLACK_OAUTH_CLIENT_SECRET`: credentials from your Slack app.
- `SLACK_OAUTH_REDIRECT_URI`: the exact registered **HTTPS** URL ending in `/api/communication-connection/callback`, without a query, fragment, or URL credentials. Forward that URL to the Helmsman server through your HTTPS proxy.
- `SLACK_OAUTH_TOKEN_FILE`: an absolute path to a private JSON credential file, outside the galleon and plugin package. Helmsman creates it with mode `0600`; its parent must be owned by the server user and not writable by other users. Existing token files must be private and owned by the server user. Symlink token files and parent directories are rejected.
- `SLACK_CLIENT_ID`: the Slack workspace ID (`T…`), distinct from the app's OAuth client ID.

Any nonempty OAuth setting opts into OAuth mode; incomplete configuration reports setup required. Empty optional environment values preserve direct-token mode. OAuth mode never falls back to `SLACK_MCP_TOKEN`, including after disconnect or refresh failure. It still needs an approved Slack application and does not bypass workspace approval. This is separate from the opt-in OI Companion provider.

Use the selected provider's connection controls to connect, inspect status, check, or disconnect. The authorization request asks only for user scopes `channels:read`, `chat:write`, and `search:read`, covering public-channel review requests and discovery. Private-channel lookups additionally require `groups:read`; the minimal app flow does not request that scope. The plugin verifies the returned user token, granted scopes, expected workspace and non-bot user with Slack `auth.test` before retaining the grant. Checks use `auth.test` and never send Slack messages.

OAuth state is cookie-bound, expires after ten minutes, and is consumed once. Starting another connection, disconnecting, or changing app/workspace settings invalidates in-flight callbacks and refreshes. Immediately before storing an exchanged grant, the host also verifies that the selected provider and its settings are unchanged. Credentials are written atomically with private permissions; they are not stored in plugin settings, public status, logs, or operation receipts. Disconnect removes the locally retained grant and pending state; it does not revoke the Slack app installation.

Tokens refresh when they have less than a minute remaining, with one refresh shared by concurrent callers in the provider instance. Every replacement token is verified against the same Slack workspace and user. Connection identity is stable across token rotation and changes for a new account grant. Expired, disconnected, or errored credentials expose no connection identity, keeping delivery admission paused. Reading connection status or running a check can refresh an expired grant and restore its original identity; failed refresh requires retrying or reconnecting. These controls make no Slack writes.

## Delivery and discovery

The client initializes MCP Streamable HTTP, sends the initialized notification, then calls tools. It accepts JSON and SSE responses; requests time out after 15 seconds, operations after 60 seconds, and response bodies are limited to 2 MiB. The deployed server is stateless; no session credential is persisted.

Preparation and delivery validate the exact channel through `get_channel_info`. Immediately before `send_message`, the provider invokes the host's `beforeSend` authorization fence and checks that its credential has not changed. Only a matching channel and valid Slack timestamp count as an acknowledgement. There are no write retries. Any error after dispatch is ambiguous, including a lost response or malformed receipt. Reconciliation never sends: without an exact durable Slack receipt it remains unknown, requiring manual inspection before another request.

Discovery uses `search_messages`, which includes matching thread replies. Each scan fixes its search date window, filters timestamps against the requested cursor and captured start time, and reads at most ten 100-message pages. Pagination changes, duplicates, malformed entries, and page-limit exhaustion report incomplete rather than advancing the host cursor. Slack search indexing is eventually consistent; the host's overlapping scans reduce but cannot eliminate indexing delays. Only GitHub pull request links in message text are normalized; unfurled attachments are not interpreted as new requests.

## Verified upstream

Implemented against [`gdcorp-dna/slack-mcp`](https://github.com/gdcorp-dna/slack-mcp/tree/48c58ee8301b2834e38ce099380fe20f25505d46), commit `48c58ee8301b2834e38ce099380fe20f25505d46`:

- [Integration specification](https://github.com/gdcorp-dna/slack-mcp/blob/48c58ee8301b2834e38ce099380fe20f25505d46/docs/Slack%20MCP%20Integration%20Specification.md)
- [Channel tools](https://github.com/gdcorp-dna/slack-mcp/blob/48c58ee8301b2834e38ce099380fe20f25505d46/src/slack_mcp/tools/channels.py)
- [Message tools](https://github.com/gdcorp-dna/slack-mcp/blob/48c58ee8301b2834e38ce099380fe20f25505d46/src/slack_mcp/tools/messages.py)
- [OAuth passthrough and disabled discovery routes](https://github.com/gdcorp-dna/slack-mcp/blob/48c58ee8301b2834e38ce099380fe20f25505d46/src/slack_mcp/oauth.py)
- [Stateless HTTP server](https://github.com/gdcorp-dna/slack-mcp/blob/48c58ee8301b2834e38ce099380fe20f25505d46/src/slack_mcp/server.py)

The upstream README's OAuth metadata discovery description differs from the server implementation, which disables well-known routes. This client therefore uses an explicitly supplied user token rather than assuming automatic discovery works.

## Build and test

Build the SDK first, then run `npm run build --prefix src/plugins/slack-companion` from the galleon root. `npx vitest run src/plugins/slack-companion` exercises mocked MCP requests, credential handling, ambiguous writes, pagination, OAuth state and refresh fencing, private storage, and malformed responses. These tests do not send Slack messages or change account authorization.

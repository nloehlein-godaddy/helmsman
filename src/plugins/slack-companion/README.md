# Slack Companion communication provider

This SDK-only package implements Slack review requests and watched-channel discovery using GoDaddy's Slack MCP service behind the [Slack GoCaaS OI Companion](https://godaddy-corp.atlassian.net/wiki/spaces/xform/pages/4509107536/Slack+GoCaaS+OI+Companion+Overview). It needs no Firefox extension, browser session, or GoCaaS model request.

The bundled plugin is `helmsman.slack-companion`, with communication local ID `slack`. The standalone package descriptor uses `example.slack-companion`. It declares `provider-network` access and registers only through `@helmsman/plugin-sdk`.

## Configuration

Set `SLACK_MCP_TOKEN` in the Helmsman server environment to your **Slack user OAuth token**. A GoCaaS API key is not accepted by Slack MCP. Obtain the token through your organization's approved Slack authorization process. This plugin does not implement interactive OAuth, read another application's credentials, or refresh expired tokens. Token expiry requires replacing the environment credential and restarting the server.

`SLACK_MCP_URL` defaults to `https://mcp-slack.goarena.gdcorp.tools/mcp`. The only alternative is the documented test endpoint, `https://mcp-slack-test.goarena.gdcorp.tools/mcp`. Redirects are rejected so credentials cannot be forwarded to another endpoint. Tokens are never stored in plugin settings, operation records, or response evidence. Connection identity is a SHA-256 digest of the endpoint and credential, so replacement invalidates old retained connections.

Select the Slack Companion communication provider. Configure the Slack workspace ID, review channel **ID** (`C…` or `G…`), and reviewer user group **ID** (`S…`). Channel names and user group handles cannot safely replace these identifiers: durable operations pin the exact channel, and the documented MCP service does not expose a user group lookup tool. The message uses Slack's `<!subteam^ID>` mention format. Watched-channel discovery uses its separately configured channel ID.

The token needs access to those channels and scopes sufficient for `conversations.info`, `chat.postMessage`, and `search.messages` (`search:read` is required for discovery). Slack enforces the caller's channel permissions. A token without search access can send reviews but cannot discover review requests.

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

Build the SDK first, then run `npm run build --prefix src/plugins/slack-companion` from the galleon root. `npx vitest run src/plugins/slack-companion/provider.test.ts` exercises mocked MCP requests, credential handling, ambiguous writes, pagination, and malformed responses. These tests do not send Slack messages or change account authorization.

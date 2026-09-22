# OI Slack Companion communication provider

This opt-in SDK-only provider uses the hosted `godaddy-slack-companion` model in OI and the user's existing Slack OAuth connection. It does not need a Helmsman Slack application or a Slack token. The bundled plugin is `helmsman.slack-oi`; its communication local ID is `slack`. The standalone package descriptor uses `example.slack-oi` and declares `provider-network` access.

**Currently blocked by the production OI deployment:** native tool approval is disabled. The provider refuses to start tool requests when approval is unavailable. Installing or selecting the plugin does not enable this server capability. The existing direct MCP Slack provider remains the default.

## Configuration

Set `SLACK_OI_TOKEN` to an OI credential, or use `SLACK_OI_TOKEN_FILE` with the absolute path to a private token file. This credential authenticates to OI; it is not a GoCaaS model API key or Slack OAuth token. `SLACK_OI_AUTH_MODE` accepts `bearer` (default) or `sso-jwt`. `SLACK_OI_URL` defaults to `https://caas.open-webui.godaddy.com`.

Authorize Slack through OI's existing Slack Companion integration and set `SLACK_OI_OAUTH_SESSION_ID` to that OI session's `oauth_session_id` cookie value. OI requires this session cookie in addition to the API credential to locate the user's existing Slack authorization. Treat it as a secret. An API credential alone cannot activate Slack tools, and an expired or revoked OAuth session requires replacing the configured value.

This package does not install a Slack application, implement OAuth, retrieve browser credentials, or refresh credentials. Configure the workspace ID, review channel ID (`C…` or `G…`), and reviewer user group ID (`S…`) in Helmsman's communication settings. Watched-channel discovery uses its separately configured channel ID. Channel names and user group handles cannot replace these identifiers.

Credentials remain in the server environment or private token file. Connection identity is a SHA-256 digest of the OI URL, authentication mode, credential, and OAuth session ID; replacing any of them invalidates retained connections. The transport validates its endpoint and rejects redirects.

## Delivery and discovery

The transport requires OI native tool approval. It accepts only the exact requested tool and arguments and reads the structured tool result; assistant prose is not a Slack receipt. Unexpected tool requests are not approved. For delivery, the provider invokes the host's `beforeSend` authorization fence immediately before approving the exact `send_message` call, then checks for cancellation and credential replacement.

Only a matching channel and valid Slack timestamp count as delivery acknowledgement. There are no automatic write retries. Errors after approval begins are ambiguous; reconciliation never sends another message. An unknown delivery requires inspecting Slack before manually retrying.

Preparation validates local configuration and destination without network requests. Invocation checks OI readiness before creating a chat, so disabled native approval produces a definite failure in the durable operation receipt. Delivery requests only `send_message` for the exact configured channel ID; Slack enforces channel availability and permissions. Watched-channel discovery uses only `search_messages`, including matching thread replies. Each scan uses a fixed search window, filters results to the requested cursor and captured start time, and reads at most ten 100-message pages. Changing pagination, duplicates, malformed messages, and page-limit exhaustion report an incomplete scan. Slack search indexing remains eventually consistent. Transport requests have bounded timeouts and honor the host's operation cancellation signal.

## Build and test

Build the SDK first, then run `npm run build --prefix src/plugins/slack-oi` from the galleon root. Run `npx vitest run src/plugins/slack-oi` for transport and provider tests. These mocked tests do not send Slack messages or change account authorization. Live availability must be verified against the OI deployment before enabling automated delivery.

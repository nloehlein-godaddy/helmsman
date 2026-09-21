# Retired feature routes and retained recovery

Optional features admit new work through their public plugin services. Removing or disabling a selected package does not restore the former private implementation. The following endpoints return HTTP 410 even when the replacement service is unavailable.

| Retired entry point | Replacement |
|---|---|
| `/api/dashboard`, `/api/triage`, `/api/bugs` | Task-source, task-view and run-read services supplied through page/panel context |
| `/api/pr`, `/api/pr/diff`, `/api/pr/open`, `/api/pr/review-requests` | Public pull-request read and inspection services |
| `/api/pr/review` | Durable pull-request commands with caller identity and exact-head binding |
| `/api/slack/review-request` | Durable communication commands |
| `/api/slack/notifications/:id/read` | Scoped communication notification service |
| `/api/campaigns` and its subroutes | Scoped campaign service and durable commands |
| `/api/repo/local` | Scoped Local Git service |
| Writes to `/api/clarifications`, clarification answers and `/api/trusted-contacts` | Versioned clarification commands, suggested-contact administration and retained worker attempt channels |
| `/api/cmux/*`, `/api/github/profile` | Scoped terminal and selected profile services |
| `JIRA_*`, `GITHUB_*` and `SLACK_*` writes through generic `/api/config` | Revision-checked integration/communication settings; live Jira fields belong to source instances |

Authors should use the [public SDK services](plugin-packages.md), not raw replacement URLs. The SDK carries scope, cancellation, caller identity, durable request receipts and versioned validation.

The read-only `/api/slack` diagnostic remains available, including its disabled safe-start response. Historical clarification reads and core run/recovery controls remain. Old Todo request IDs and journals still use their original recovery service; retirement never remaps an uncertain mutation into a new command.

Existing run snapshots, normalized trigger queue rows, claims, checkpoints and pending external effects retain their original identity. Recovery-only agent, host, workflow and publication adapters remain because disabling an optional feature must not discard obligations or substitute today's selected provider. Compatibility package IDs such as `helmsman.compat-pr` and `helmsman.compat-clarifications` remain stable; their implementations use public SDK contracts.

One-time environment bootstrap readers are migration inputs. They do not override explicit plugin settings or selections after conversion. Removing a legacy HTTP entry point does not delete credentials, historical databases, archived artifacts or saved layouts.

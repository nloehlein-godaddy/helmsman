# Jira and GitHub settings

The independently buildable `helmsman.jira-settings` and `helmsman.github-settings` packages own their pages and forms. Config links to `/jira-settings` and `/github-settings`, including when core runtime configuration is unavailable. Each page composes a replaceable panel through its matching `helmsman/jira-settings-page` or `helmsman/github-settings-page` slot and version 1 panel contract.

## Namespaces and public services

Declare `helmsman/jira-settings@1` to use `services.jiraSettings`, or `helmsman/github-settings@1` to use `services.githubSettings`. The SDK exports bounded field schemas and typed parsers. Each service has `snapshot({ version: 1, scope: 'global' })`; these settings are explicitly global and never change the header galleon.

| Namespace | Editable values | Redacted status |
|---|---|---|
| `helmsman.jira/settings` | Write-only API token through `rotateToken` | Token presence, initial source presence and bootstrap enablement |
| `helmsman.github/settings` | Default galleon, PR author, review-watch enablement through `save` | Token presence |

Writes include the namespace and `expectedRevision` from the snapshot used to start editing. Core validates the typed values, compares the revision and writes through the existing configuration store in one application-database transaction. Namespace revisions and a startup generation protect concurrent changes and restart. Public revisions contain no credential values or credential hashes. Effective nonsecret GitHub settings remain readable without credentials.

Keep the original revision and edits on conflict. Refreshing data must not silently rebase an unsaved draft. Saving never retries automatically; after a lost response, refresh and inspect the current settings before explicitly saving again. GitHub review scheduling remains the existing Phase F adapter; its policy is not implemented by the settings panel.

## Jira credentials and live sources

The token stays in memory while editing and travels only in the explicit rotation request. Never persist it in browser storage, command journals, receipts, URLs or logs. Core returns only redacted status; error responses never echo the submitted value. Clear the submitted token after confirmed success while preserving any newer edit. Credential resolution continues to verify the retained Jira origin, account and authority before use.

Initial Jira environment defaults only provision an absent source at startup. Saving a token neither creates nor enables a source. Existing Jira project, JQL, assignee, statuses, enablement and allowed galleons belong to the revision-checked [Source settings](task-source-authoring.md) service. The Jira package links there instead of maintaining another editable copy. Existing overrides remain retained; the core galleon registry still owns `REPO_PROJECT_MAP` keys independently of live source configuration.

Normal application mode rejects migrated Jira/GitHub writes through `/api/config`. Core Config writes return `{ ok: true }`, never the submitted key/value pair. Plugin settings remain independently available while the underlying integration provider is disabled; authorization still requires an enabled contribution declaring the relevant settings capability.

## Packaging

Copy `plugin-sources/jira-settings` or `plugin-sources/github-settings`, rename its package and initial-layout contribution IDs, and build against the distributed SDK. Keep the public slot and panel contract identifiers. Select a replacement with `plugins select helmsman/jira-settings-page example.jira-settings/page` or the equivalent GitHub slot. Missing selections preserve saved layouts and remain unavailable.

See [package operations](plugin-packages.md), [panel lifecycle](panel-authoring.md) and the [implementation ledger](plugin-implementation-progress.md) for acceptance and delivery status.

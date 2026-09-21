# Jira settings frontend package

The independently buildable SDK-only Jira settings page mounts its panel through `helmsman/jira-settings-page`. The panel implements `helmsman/jira-settings-panel@1`, requires `helmsman/jira-settings@1`, and uses injected `services.jiraSettings`. Package-owned field metadata identifies the global `helmsman.jira/settings` namespace.

The panel owns only a write-only API-token form and initial source setup status. Project, JQL, assignee and source enablement remain in Source settings. The link preserves header repository scope. Saving a token does not provision or enable a source; missing sources receive an explicit initial-setup/restart explanation.

The token remains in memory, including during conflicts and uncertain saves. It is never saved in localStorage, sessionStorage, plugin saved state, journals, receipts or logs. The stable password input receives the value through its DOM property; it is never interpolated into HTML or an attribute. Errors use fixed redacted copy. Disposal clears the retained input and in-memory value. A successful save clears only the submitted token; newer typing survives.

Refresh retains the original revision for an existing token draft. Rebase and discard are explicit actions. Saves include global scope, namespace and expected revision, do not change header scope and are never retried automatically. Inactive lifetimes cancel reads/saves; late responses cannot replace drafts. Snapshot validation rejects unexpected fields, including secret fields.

Build here with `npm run build`. Focused tests from the repository root: `npx vitest run src/plugins/jira-settings/page.test.ts src/plugins/jira-settings/panel.test.ts`. Tests use fake tokens and mocked public services.

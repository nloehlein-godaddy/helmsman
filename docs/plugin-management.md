# Manage plugins

Open **Config → Plugins**. This page belongs to Helmsman's core and remains available when optional plugins are disabled. Plugin changes apply to the whole application; the header galleon selection is retained for navigation to Task sources.

Search the list by plugin name or ID. Each entry identifies whether it is an external package or a bundled plugin. Each entry shows its version, enabled state, and runtime health.

## Install or update

Choose **Install plugin** and select a `.hmp` archive. Helmsman validates the package and shows its identity and version before installation. Confirm that you trust the package, then install it. New packages are initially disabled; enable them when ready to run their code.

For an existing external plugin, disable it before installing different package bytes. Select its update action and choose the new archive. The package ID must match the plugin being updated. Existing settings and page selections are preserved; previous artifacts remain available for retained work.

Bundled plugins ship with Helmsman and update with the application. They cannot be replaced by uploading an external archive or removed independently.

Restart Helmsman when the page reports that a restart is required, then reload open browser tabs. A saved enabled state does not mean the backend has activated the new code in the current process. There is no automatic package download or update service.

## Disable or remove

Disable stops new use of a plugin. Previously captured work retains its original implementation. Removing an external package keeps settings, layout selections, and historical provenance. Helmsman rejects removal when retained work still needs the package; resolve that work through Recovery rather than deleting its files.

Changes are checked against the version and state displayed in the page. If another tab or the CLI changes a package, refresh before making another change. If a response is lost, refresh to inspect the current state before repeating the action.

## Recover a task source

Updating a package does not automatically change a saved Jira or Todo source binding. Open **Config → Task sources**, select the affected source and a galleon, then use **Replace source implementation**. Select a compatible installed implementation, enter the actor and reason, and choose **Validate replacement**. Apply it only after validation succeeds.

Validation checks source identity and recorded task evidence. A failed validation leaves the original source selected. Changing an API token does not repair an unavailable pinned provider.

If validation reports that Jira rejected the configured credentials, update the token under **Config → Jira**, then retry validation. A Jira access-denied error instead requires checking the account's permissions and token scopes.

The [plugin package guide](plugin-packages.md) documents the equivalent CLI commands and package authoring workflow.

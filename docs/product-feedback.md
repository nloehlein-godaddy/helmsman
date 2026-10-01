# Product feedback

Product feedback is disabled until an operator selects and configures a tracker. No destination repository or labels are assumed.

## Configure and submit

1. Open **Config → Product feedback settings**.
2. Choose the feedback tracker. The included **helmsman.feedback-github/issues** provider uses the application's existing GitHub connection; configure that connection in **GitHub settings** first.
3. Set `repository` to the issue destination (`owner/repository`), optionally enter comma-separated `labels`, and turn on `enabled`.
4. Save, then restart Helmsman to apply backend settings. Return to Feedback settings and use **Send product feedback** once the destination is available.
5. The **Product feedback** footer link beside Pirate mode now opens the form directly. Check the displayed destination, enter a title and reproduction details, and submit.

Selecting **Disabled** stops new admissions. Existing drafts and submissions remain recoverable through **View saved feedback** in Feedback settings. The footer link opens settings while the tracker is unavailable. Tracker settings apply to new admissions after restart, while pending submissions retain the original provider artifact, settings, connection identity, and destination. The built-in submission and settings pages can be independently replaced through their page slots.

Unsent drafts persist in this browser per presentation contribution and selected galleon. A changed destination does not silently redirect a saved draft: **Use current destination** explicitly binds a new draft identity. The contextual metadata includes the Helmsman version, selected galleon, and presentation identifier. It excludes logs, credentials, task bodies, and plugin settings.

A lost response keeps the original request in the browser journal and server ledger. **Check original submission** reconciles that same request. GitHub reconciliation requires an exact marker, title, body, author, destination, and canonical issue URL. Missing or ambiguous search results never cause another issue to be created. A definite rejection allows **Create revised submission**; successful submissions provide the issue link and an explicit **New feedback** action.

Core Recovery shows retained submissions under their originating galleon; submissions made from All galleons appear in the unfiltered view. Only the retained tracker can confirm success with a canonical issue receipt. Manual resolution offers **Confirmed not applied**, requires evidence, and never substitutes an operator acknowledgment for that receipt.

Settings saves use the displayed revision. After a lost save response, Refresh reads the durable configuration and retains the unsent settings draft. If another save changed that revision, **Review draft against latest settings** explicitly prepares the retained draft for review before a new save. Saving settings never submits feedback.

## Plugin contracts

A dedicated backend package declares `helmsman/feedback-tracker@1` with `feedbackTrackers[localId].access = ['connection-http']`. It registers destination, prepare, invoke, and reconcile methods. Backend activation exposes only settings, lifetime cancellation, cleanup, and tracker registration. Credentials remain in core. The initial application connection is GitHub; the public command and presentation contracts do not expose a tracker-specific destination structure.

Preparation returns an immutable POST plan containing exactly one `{{helmsman-feedback-marker}}` placeholder. Core persists that plan, the caller/request identity, artifacts, settings, and connection binding before dispatch. Invocation permits one exact planned POST. Reconciliation receives read-only HTTP. Providers must return an acknowledged canonical receipt, evidence of definite nonapplication, or unknown; absence of a remote marker is not evidence of nonapplication.

The public `helmsman/feedback-command@1` service supplies destination/context, submit, receipt, retry, pending, and acknowledge. Its caller-scoped IndexedDB journal reserves a request ID before HTTP and refuses changed content for a retained draft. `helmsman/feedback-settings@1` separately authorizes configuration and exposes tracker-owned setting declarations without credentials.

The included source packages are [Product feedback presentation](../src/plugins/product-feedback/README.md) and [GitHub Issues tracker](../src/plugins/feedback-github/README.md). They build against the distributed SDK without application imports.

CLI equivalents:

```sh
helmsman plugins configure helmsman.feedback-github '{"enabled":true,"repository":"owner/repository","labels":"feedback"}'
helmsman plugins select-feedback helmsman.feedback-github/issues
helmsman plugins select-feedback disabled
```

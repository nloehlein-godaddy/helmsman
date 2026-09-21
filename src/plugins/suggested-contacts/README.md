# Authored suggested contacts

`helmsman.suggested-contacts/panel` implements `helmsman/suggested-contacts-panel@1`. It is an independently installable panel, composed by the opt-in authored question page; it has no standalone page or legacy alias binding. Its only required service is `helmsman/suggested-contact-admin@1`.

Contact administration is explicitly global. Bounded pages contain 25 contacts. Create and update preserve arbitrary address text, explicit enabled state and current contact revisions. Editing captures an expected revision; refresh never silently rebases an edit. After a stale rejection, save its result, discard the old edit, refresh and explicitly open a new edit. Saving contact metadata sends no messages.

The host journal reserves create request/contact IDs and retains immutable inputs across response loss and reload. Check receipt never sends again; Retry original preserves the original command. Terminal results and newer drafts persist through public conditional saved-state storage before acknowledgment. Conflicting saved state retains local edits and requires explicit reconciliation. Drafts remain separate from command inputs, and cleanup protects unresolved request evidence.

Per-panel state retains one create draft, up to 64 update drafts and 32 compact terminal results, bounded to 512 KiB. Storage failure leaves recovery evidence; unsupported state is preserved read-only. Header changes cancel in-flight work but do not change global data scope. Hiding or disposing the panel cancels its work independently of questions.

The compatibility recovery link preserves header scope and opens the original contribution. No compatibility drafts, journals or receipts are adopted or automatically replayed. Build with `node build.mjs` against the copied distributed SDK and TypeScript. Runtime imports remain inside this package. See [authored clarification authoring](../../../docs/authored-clarifications.md).

_Helmsman · not reported - not reported_

Retry requires the host's optional exact-request `retry` method. It never calls `submit` to recreate a missing reservation; older hosts disable retry and retain receipt checks.

# Clarification compatibility page

This bundled bridge exposes the existing question/contact renderer through the normal page lifecycle. Its `helmsman.compat-clarifications/page` contribution declares separate public clarification read, durable answer-command and global suggested-contact facets. It is tracked compatibility code; it is not a standalone author package and still imports the legacy renderer and styles.

The legacy `/clarifications` page and canonical `/plugins/helmsman.compat-clarifications/page` use the same durable browser adapters. Question drafts and unsent contact drafts remain separate from reserved commands. Acknowledgment follows durable result storage; an accepted answer does not prove worker consumption. Saving a contact sends no message. Disabling the contribution prevents new public service calls and preserves journals for reconciliation after reenablement.

Saved drafts and results have separate bounded records. Explicit cleanup requires a fresh successful journal read and preserves unresolved command evidence; global contact draft cleanup is separate from scoped answer drafts. Storage failure keeps the command pending until the affected draft and result are saved. See the [author guide](../../../docs/clarification-authoring.md) for limits and recovery behavior.

Phase E still needs a fully authored clarification page/panel before this bridge can retire. See [implementation status](../../../docs/plugin-implementation-progress.md), [backend contract](../../../docs/clarification-backend.md), and [E4 plan](../../../docs/plugin-phase-e4-implementation.md).

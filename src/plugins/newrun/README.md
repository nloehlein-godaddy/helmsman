# New Run panel

`helmsman.newrun/panel` uses only the public task-read and run-command services. Build with `node build.mjs` after installing TypeScript and `@helmsman/plugin-sdk`; package `dist/` with the Helmsman plugin CLI.

Freeform tasks, PR reviews, branch updates, and canonical source tasks share one scoped launch form. Header galleon scope is authoritative. In all-galleon scope, choose a permitted galleon explicitly. Source tasks come from source discovery, paginated ready-task reads, or the optional scoped task-key lookup service, and are loaded again before launch. A display key is resolved by its selected provider; it is never treated as a canonical external ID.

Drafts are saved per galleon in panel instance state. The combined saved state is bounded to 16 KiB; save failures retain local text and prevent launch. Unknown saved-state versions remain untouched. A hidden panel suspends reads and transport without deleting drafts or command records.

The host journals launch identity before dispatch. Saved requests survive reload, and explicit Retry delivery calls optional `retry({ repo, requestId })` to reuse the retained original command. It never reserves a replacement: an acknowledged or missing entry sends nothing. Older hosts without this method disable Retry delivery while keeping Check request available. A receipt records command acceptance, not worker success. Terminal receipts remain until Dismiss request succeeds after saving the current draft. Recovery-required requests cannot be redispatched here.

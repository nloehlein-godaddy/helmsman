# Second-pass plugin lifecycle corrections

This change resolves RR04 and RR05 from the [second adversarial review](adversarial-review-2026-09-21-round-2.md). It was implemented in an isolated worktree from `27a3494`; no production runtime, credentials, external provider or shared fixture was used.

RR04 now separates immediate invalidation from completed disposal. Each activated backend memoizes its cleanup promise, so a runtime shutdown joins a cleanup already started by disablement. The runtime itself memoizes its disposal promise. Retained agent, execution-host, native-terminal and workflow loaders, plus backend materialization leases, use the same joinable-disposal rule. Callers still see providers invalidated immediately; they now wait for the bounded asynchronous cleanup already in progress.

A subsequent cross-review confirmed that callbacks registered synchronously from an abort listener or during another callback were still accepted on a detached late-cleanup path. The shared cleanup queue now joins those callbacks before completion, bounds recursively registered work without extending the initial drain budget, and retains bounded best-effort execution for registrations after the drain completes. Ordinary and all four retained loaders share this policy. Disposal promises are assigned before abort notifications, while invalidation remains immediate.

RR05 records the intended artifact, desired state and revision before archive publication, then checks them against the authoritative lifecycle record while the coordinated installation transaction holds the persistence lock. A replacement of a different artifact now rejects when any concurrent lifecycle transition wins before commit. Identical-hash installation retains its existing fast path and selection state.

Focused verification passed on 2026-09-21:

- `npx tsc --noEmit`
- `npx vitest run server/helmsman/plugins/backend.test.ts server/helmsman/plugins/coordinator.test.ts server/helmsman/agent-providers.test.ts server/helmsman/plugins/materialize.test.ts server/helmsman/execution-host-providers.test.ts server/helmsman/native-terminal-providers.test.ts server/helmsman/workflow-providers.test.ts` — 82 tests across seven files

The late-registration correction additionally passed 76 focused tests across the cleanup queue, ordinary backend and four retained-provider test files, including abort/cleanup registration gates and bounded self-registration.

The replacement regression uses two real SQLite persistence connections and a disposable archive-publication watcher. The disposal regressions prove that a second caller remains pending until the first callback finishes. Full aggregate, production build and installed-application gates are owned by the integration worktree.

_Helmsman · not reported - not reported_

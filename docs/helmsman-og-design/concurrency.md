# Same-galleon parallel voyages: implementation design

Read-only design against `edd5a8a530b86189361b15e1e1c425f9f168ece6`. No production changes, commits, build, tests or live application operations performed.

## Decision and rollout boundary

Make parallel work an explicit per-galleon policy with a default maximum of **1**. Keep the existing global `AGENT_MAX_CONCURRENCY` ceiling (currently default 3). An opt-in galleon maximum cannot increase the global ceiling. Initially use exclusive collision claims: two executions of the same canonical task, branch, PR, or workspace conflict, including two reviews of different heads of one PR. Distinct tasks on independent branches may overlap only when both have complete, verified execution footprints. Unknown identity gets conservative exclusive galleon/check-out protection, never an empty resource set.

Implement in separate stages: resource/cleanup correctness with capacity still 1; migration/recovery verification; explicit policy controls; automatic scheduling/campaign enablement. Do not turn off the existing galleon exclusion before all admission, continuation, recovery, cleanup and campaign paths use the replacement.

## Actual current constraints

- `server/helmsman/execution-store.ts` owns `core.execution@1`. `execution_reservations(runId PRIMARY KEY, repo TEXT COLLATE NOCASE UNIQUE, reason)` enforces galleon exclusion. `reserveAdmission()` and `prepare()` also explicitly reject another reservation for the galleon; they use synchronous immediate SQLite transactions through `persistence.transaction`.
- `admission-store.ts` reserves capacity before inserting the immutable admission and artifact pins. `application.ts:launch()` separately checks `ProcessManager.canStart(repo)`, captures provider/source selections, then atomically reserves the source claim and admission. Readiness and external preparations follow admission.
- `process-manager.ts` merges durable reservations with attached processes by run ID. `application.ts` also contributes legacy active rows missing durable reservations. Both global count and galleon exclusivity currently depend on this union, not just live subprocesses.
- `runner-durability.ts:finalize()` releases the capacity reservation after terminal evidence even when it retains a resumable checkpoint. Capacity ownership and branch/workspace obligations therefore cannot become the same table/lifetime.
- `task-sources/store.ts` independently has `UNIQUE(sourceId, externalId) WHERE state != 'settled'`. Source identity survives instance replacement. Do not put source instance ID into task collision identity or weaken this index.
- `campaigns.ts:canClaim()` independently rejects any active campaign task for the same galleon across campaigns. Campaign concurrency already permits 1–20, but cannot currently overcome that guard. `campaign-dispatcher.ts` makes separate advisory capacity checks.
- `scheduler.ts` launches at most one item per enabled galleon per tick. `task-source-schedule.ts` maintains a CAS discovery cursor and discards older outstanding decisions for the same galleon. Parallel discovery within a galleon would invalidate decisions and produce avoidable races.
- `worktree.ts:createWorktreeFromBranch()` fetches into shared `FETCH_HEAD`, reads it in a second command, then force-updates a branch. Concurrent preparation can overwrite that shared observation. Workspace paths are run based, but checkout lookup uses `repoBasename(repo)`: `owner-a/app` and `owner-b/app` can alias the same checkout. Canonical checkout ownership must be verified before parallel use.
- Current snapshot construction in `legacy-execution-snapshot.ts` declares `core.execution` minimum/maximum 1. `task-source-execution.ts` inherits that declaration. `migrateOwned()` examines pinned historical snapshots as well as registered artifact ranges; a retained v1 consumer blocks a v2 migration. A schema bump is not transparently safe.

## Minimal durable contracts

Add a core-owned execution policy store, separate from source selection and campaign policy:

```ts
interface GalleonExecutionPolicyV1 {
  version: 1;
  repo: string;
  revision: number;
  maxConcurrentRuns: number; // integer 1..20; effective maximum also bounded by global limit
}
```

A missing row is `{revision: 0, maxConcurrentRuns: 1}`. Mutation is a durable command with caller/request ID, exact-input replay, header-galleon scope and `expectedRevision` CAS. Lowering the maximum does not cancel existing work; admissions wait until the active count falls below it. Preserve current slots/recovery even if the global limit is lowered on restart. Store the policy revision/value observed at admission as evidence, but test **current** limits for each new admission or continuation that needs a slot.

Expose policy through a dedicated `helmsman/execution-policy@1` read/control service (following the existing durable local command/service patterns). Do not add concurrency mutation to the discovery-only `helmsman/scheduling` provider, and do not silently extend the strict `SourceAdminSnapshotV1` parser. A Config/composition control can consume the new service and display effective global/galleon limits and current reservations. Old plugins remain usable and do not opt in.

Add a core-internal `ExecutionFootprintV1`, retained with the immutable admission and each prepared attempt:

```ts
interface ExecutionFootprintV1 {
  version: 1;
  repo: string;
  policyRevision: number;
  completeness: 'verified' | 'exclusive';
  resources: readonly {
    kind: 'task' | 'branch' | 'pull-request' | 'workspace' | 'galleon-exclusive' | 'checkout-exclusive';
    namespace: string;
    identity: string;
  }[];
  checkout: { identity: string; canonicalPath: string } | null;
  hostBindingHash: string;
}
```

Use bounded canonical tuples serialized with `stableJson`; retain their hash plus canonical data and verify correspondence on reads. Core derives identities from retained provider observations, validated paths and canonical source records; caller strings cannot assert ownership. Cases:

| Resource | Canonical identity and lifetime |
|---|---|
| Source task | `(sourceId, externalId)` from `WorkRefV1`, independent of galleon and source instance. Existing active source claim remains authoritative and is committed with admission. An execution collision record records ownership but never settles or supersedes a source claim. |
| Local/legacy task | Stable local collection/task ID or verified source authority/task ID. Display ticket text is insufficient. Unknown legacy authority requires exclusive fallback. Freeform runs have no externally deduplicable task identity; request/run identity provides replay protection, not prompt-text comparison. |
| Branch | Canonical Git authority + publishing galleon + exact branch ref; branch case is preserved. Also reserve the local checkout/ref alias when the same physical checkout is used. Never key by credential handle/provider version: changing credentials cannot evade the collision. A fork branch requires verified head-galleon authority; otherwise branch rerun is exclusive/unsupported. |
| PR | Canonical PR authority + canonical base galleon + number, **without head SHA**. Retain the head SHA in execution evidence for correctness, not as a way to permit simultaneous work on one PR. |
| Workspace | Canonical filesystem namespace and absolute intended path derived from a verified real parent + validated run ID. Provider-managed workspaces need a verifiable run-specific resource namespace; existing `workspace: 'clone'` metadata alone is not proof of isolation. Keep the ownership claim while the directory/checkpoint remains protected. |
| Exclusive fallback | Same-galleon or same-checkout wildcard. Checked against every existing footprint in that scope, not merely identical wildcard keys. This also protects legacy active rows missing modern identity evidence. |

For a fresh coding run, the target branch is known as `agent/<runId>`. For review, canonical PR authority/number must be known before shared admission. For branch rerun, obtain a retained PR/branch observation first. All asynchronous reads occur before the final admission transaction and are revalidated there. If the current synchronous `launch()` boundary cannot yet provide a complete footprint, reserve an exclusive provisional footprint and refine it atomically before preparation; that path does **not** gain parallel admission while another execution occupies the scope. New async preflight can later improve availability without weakening safety. No remote claim mutation or workspace creation occurs before durable admission ownership.

## Concrete schema and invariants

Advance `core.execution` to v2 with an explicit v1-to-v2 table rebuild, preserving run IDs and reason values. Illustrative final table definitions:

```sql
CREATE TABLE execution_reservations (
  runId TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  reason TEXT NOT NULL,
  policyRevision INTEGER NOT NULL,
  footprintHash TEXT NOT NULL
);
CREATE INDEX execution_reservations_repo ON execution_reservations(repo);
CREATE TABLE execution_footprints (
  runId TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  revision INTEGER NOT NULL,
  contentHash TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE execution_resource_claims (
  kind TEXT NOT NULL,
  namespace TEXT NOT NULL,
  identity TEXT NOT NULL,
  runId TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','cleanup-pending')),
  evidence TEXT NOT NULL,
  PRIMARY KEY(kind, namespace, identity)
);
CREATE INDEX execution_resource_claims_run ON execution_resource_claims(runId);
CREATE TABLE execution_policies (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  maxConcurrentRuns INTEGER NOT NULL CHECK(maxConcurrentRuns BETWEEN 1 AND 20)
);
```

`execution_policies` can be owned by `core.execution-policy@1`; the other new tables belong to `core.execution@2`. Do not delete a footprint when its capacity row is released. Resources may outlive capacity; checkpoints, uncertain publication, retained branches and cleanup can remain obligations. Use ordinary equality for branch/task/path identifiers; only verified galleon identifiers get existing case-insensitive normalization. Validate indexes, uniqueness, checks and row/JSON correspondence on startup, not just required column presence (`validateTableColumns` is currently insufficient to prove reservation invariants).

The authoritative admission transaction must:

1. Validate exact-input replay before taking fresh capacity; a retry of an already reserved run cannot acquire another slot or change its footprint.
2. Recheck current selections, policy revision, source revision, canonical PR observation and checkout authority after asynchronous preflight.
3. Compute global/galleon counts from distinct reserved run IDs, including unresolved legacy obligations and active run rows without modern reservation evidence. Attached processes are observations, never a separate slot for the same run.
4. Compare wildcard scope exclusions and atomically insert the complete resource set. Every exact collision is enforced by the resource primary key; wildcard-vs-specific and counts are enforced inside the same immediate transaction. Reject unknown schema/inconsistent ownership instead of omitting rows.
5. Reserve task source ownership, capacity, immutable admission, footprint and pins in one transaction. Collision/capacity failure rolls back the entire operation, including the source claim.

`prepare()` verifies the admitted footprint; it cannot silently derive different keys from a changed task. Continuations reacquire capacity and validate already-owned resources under the same transaction; retries with a new run ID cannot steal the prior run's checkpoint/resources. A validated explicit ownership transfer, if needed in a later release, must retire the old obligation and fence its delayed callbacks atomically. Do not invent transfer by deleting rows.

`ProcessManager.canStart(repo)` remains a cheap advisory check for UI/polling, updated for the per-galleon limit and exclusive fallbacks. Add a candidate-aware core admission query for precise task/PR/branch diagnostics. `canStart(repo)` returning true must never be treated as authorization to launch; SQLite admission is authoritative.

## Workspace, cleanup and crash recovery

Eliminate shared `FETCH_HEAD` as identity evidence. Fetch a run/attempt-specific ref with an explicit refspec, verify that exact ref's commit, and remove it only under its recorded owner. Do not mutate a target branch until branch ownership is acquired. Serialize short Git maintenance operations on the canonical common Git directory (creation/removal/ref updates/pruning); this maintenance lock is independent of long-lived execution capacity. Prefer OS-held advisory locks or durable owner discovery with fencing; expiring a timestamp alone cannot authorize another Git mutation while an old child process may still run.

Verify checkout origin/authority and canonical common Git directory, so basename collisions fail clearly rather than operating on the wrong galleon. Core-managed worktree paths can retain the existing run-based layout. Case-folding filesystems, symlinked checkout aliases and an intended path that becomes a symlink must not create two logical workspace owners. Retain canonical workspace identity before creation; after creation validate it again before launch. Isolated/custom hosts must supply validated allocation/isolation evidence or remain exclusive; do not infer custom-host safety from the built-in implementation.

Recovery uses existing `(runId, attempt, launchId)` discovery and generation-fenced leases. A lease timeout, absent log, detached process handle, or host `unknown` result never releases a slot/resource. Reattach the same attempt without readmission; never create a second worktree because the first receipt was lost. Before preparing an unresolved workspace, inspect recorded path/ref and ownership receipts and either reconcile the original operation or retain a blocked diagnostic.

Terminal evidence releases the capacity slot using current `releaseReservation()` semantics. Resource release is separate and requires no live/unknown attempt, no unfinished effect affecting that resource, no resumable checkpoint and no retained checkout that still owns the branch. Task-source claim release continues through its own settlement journal. A stopped process with a resumable checkpoint can release capacity while retaining its task/branch/workspace claims; distinct work can use the freed slot.

Cleanup enters durable `cleanup-pending` while retaining branch/workspace claims, then verifies exact run/attempt, canonical path/common-directory identity and absence of every other footprint reference before removal. Only proven removal/detachment retires the relevant claims. A crash after removal but before acknowledgement reconciles absence for the original owner; it cannot delete a newly reused path. New admissions cannot reuse a cleanup-pending resource. Route `completeRun`, startup sweep and Local Git manual/bulk deletion through that ownership check. `removeWorktree()` currently catches removal failures; such a failure must not count as proof that claims can be released.

## Scheduler, campaigns and budget

Keep the scheduling provider discovery-only. Initially preserve one launch per galleon per tick, letting repeated ticks fill opt-in capacity. A later bounded fill loop may discover then admit sequentially, rechecking remaining global/galleon capacity each time; do not issue concurrent discovery decisions for the same galleon. Rotate galleon order across ticks to prevent a busy first galleon monopolizing global slots. Treat capacity/resource conflicts as deferred work, not failed source work.

Replace the unconditional same-galleon predicate in `campaigns.ts:canClaim()` only when final admission has collision coverage. Keep campaign concurrency separate: effective occupancy is limited by global capacity, galleon policy and campaign concurrency. Campaign claiming records count toward campaign concurrency, including uncertain launch; their expiry is not proof of a failed admission. Add atomic global/galleon capacity reservation to claim/admission handoff or requeue a definitely unadmitted losing claim without changing its canonical run ID. Existing `claiming` items with an admission must reconcile that admission, not reclaim simply because no run row exists yet. Preserve phase stop/trigger revisions and existing dispatcher fairness. Campaign policy cannot opt the galleon into parallelism.

Cost enforcement today is per voyage (`AGENT_MAX_COST_USD`, observed asynchronously); there is no aggregate reserved-dollar budget. Keep that semantic explicit. Raising same-galleon concurrency redistributes the existing global slots, can accelerate spend in one galleon and can overlap several per-voyage caps; delayed/unknown telemetry means these are not strict dollar ceilings. Display the count and existing cap together at opt-in. Do not claim a new aggregate budget guarantee. A hard shared dollar limit would require a separate durable usage-reservation design and is not needed to ship concurrency safely.

## Migration, downgrade and acceptance

Migration must run under the existing writer-maintenance barrier in one immediate transaction, from a verified v1 checksum/schema. Create v2 shadow reservations, copy each old row with a conservative exclusive footprint (and any reliably provable exact resources), rename/drop only within that transaction, create indexes, then validate counts and identities before recording the new ledger entry. Preserve unresolved legacy obligations even when no modern row exists. Default every policy to 1; migration never enables parallel work. On failure the entire transaction rolls back.

**Compatibility prerequisite:** `migrateOwned()` must be allowed to block on any retained consumer with `core.execution.maximum === 1`. Do not edit content-addressed historical snapshots, widen their range by fiat, remove artifact pins, or ignore the migration guard. The first rollout should use a compatibility release capable of operating v1 with exclusion intact and v2 with the new paths. Expose migration readiness/reasons and switch to v2 only after incompatible active/admission/operation/checkpoint/source/trigger consumers are settled, or after an explicitly validated supported checkpoint migration. Because historical snapshots are selected by pinned artifact identity, merely counting active attempts is insufficient; use the actual retained range scan. Operators with long-lived v1 obligations must retain working v1 recovery rather than encounter a startup failure. New v2 snapshots declare the correct schema range; compatible v1 snapshots need demonstrated reader support, not just a declaration change.

Rollback after parallel data exists means deploy the compatible release and set policy to 1, then drain excess runs normally. An older binary expecting v1 must reject v2 through the migration ledger. Do not auto-downgrade or reconstruct the UNIQUE(repo) table while multiple owners exist. Restoring a pre-migration DB while external runs/effects have advanced is not a safe rollback.

Acceptance gates, before opt-in is exposed:

- Default-one behavior across every launch origin; two independent runs admitted with maximum 2; third blocked; global ceiling still wins; limit reduction drains without cancellation.
- Two SQLite connections race to admit: exactly one winner for same task/branch/PR/path and correct global/galleon counts. Same task across source-instance revisions and galleon aliases still conflicts; equal display ticket text from different verified sources does not.
- Campaign and manual/review/scheduler launches race; campaign claims/admissions reconcile without duplicate run IDs or slot leakage. Sequential source discovery supports two runs without invalidating the first decision.
- Different heads of the same PR conflict. Provider/credential replacement cannot change canonical resource identity. Missing/fork branch authority fails closed.
- Restart at every admission/workspace/ref/launch/cleanup boundary; unknown host discovery retains resources; no duplicate subprocess or workspace; stale attempt lease cannot remove a newer attempt's workspace.
- Failed pre-PR checkpoint releases capacity but retains branch/workspace/task protection; continuing reacquires capacity; independent work can proceed. Unsettled source claim remains protected after capacity release.
- Parallel preparation does not read shared `FETCH_HEAD`; same-basename galleons, symlink aliases, preserved failure worktrees and Local Git cleanup cannot cross ownership.
- Fixture databases migrate v1→v2 with no record loss; crashes/faults roll back; v1 retained consumer blocks safely; invalid uniqueness/index corruption is rejected; compatible-release drain works; old binary refuses v2.
- Relevant execution/admission/process-manager, runner durability/recovery/worktree, source scheduling, campaign dispatcher/store, Local Git and schema tests; tsc/build and policy-control visual/accessibility checks. A copied-SDK external plugin smoke confirms unchanged discovery and old execution-host compatibility paths.

Primary affected paths: `server/helmsman/{execution-store,admission-store,process-manager,runner-durability,runner,application,worktree,scheduler,task-source-schedule,campaigns,campaign-dispatcher,migrations,legacy-execution-snapshot,recovery-service,local-git-runtime}.ts`; source admission/settlement callers; publication/gateway ownership assertions; new policy/footprint services and their public capability wiring. Retain SDK v1 host/discovery behavior; any future provider isolation extension must be explicit and default missing support to exclusive operation.

_Helmsman · not reported - not reported_

## Implemented compatibility and cleanup boundary

The application requests execution schema 2, but opens schema 1 when retained consumers require it. Schema 1 continues to admit one voyage per galleon. The policy service reports the exact retained snapshot/artifact identities blocking migration; changing the maximum above one requires schema 2. Historical snapshots and artifact pins are preserved. A still-present worktree belonging to a version-1-only snapshot also keeps that reader active, even after its execution pins settle. Settle its existing checkpoint/workspace through the compatible runtime and restart before opting in.

New workspaces record filesystem allocation receipts under `core.execution-workspaces@1`, including directory/device/inode/birthtime and Git administration identity. Recording works while the execution store still uses schema 1. A missing workspace can be reconciled only after both directory absence and Git deregistration are proved. An existing migrated workspace without a receipt is retained for explicit reconciliation; automatic cleanup does not adopt its current contents as proof of original ownership.

Local Git branch release and feedback retry use a durable detachment transition. The old owner enters cleanup-pending, retains every claim while Git detaches under the maintenance lock, then retains a workspace-only claim after identity and detached-HEAD verification. The next feedback run can acquire the known branch/task independently; the old dirty inspection workspace remains protected from reuse. Checkpoint continuation keeps the original run/workspace and reacquires capacity under its retained footprint. It does not recreate the workspace.

The Git maintenance lock never expires or automatically steals a stale owner. A crash leaves a recovery-required lock directory and recorded owner; an operator must verify that the previous Git work has stopped before recovering that lock. No timeout or missing process attachment releases execution resources.

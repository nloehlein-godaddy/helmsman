# Local Git authoring

The SDK-only `helmsman.local-git` package owns `/local-git`. Its composition slot is `helmsman/local-git-page`, its panel contract is `helmsman/local-git-panel@1`, and its initial panel instance is `local-git`. Config links to this page; old `/config?pane=local-git` links resolve to it with the same header scope.

## Public service

Declare `helmsman/local-git@1` and use `context.services.localGit`. The panel inherits the header galleon; composition instance overrides never change the header. A concrete galleon is required for checkout operations.

| Method | Behavior |
|---|---|
| `snapshot({ version: 1, repo })` | Read branches, worktrees, protections, checkout path and an opaque revision. |
| `preview({ target, force })` | Read cleanup candidates and skipped branches against the observed target; never delete. |
| `control({ version: 1, target, operation })` | Reserve the original command identity, then request one confirmed operation. |
| `receipt(query)` | Read the original result without repeating the operation. |
| `inspect(query)` | Inspect a retained command; atomically fence it if no dispatch was recorded. |
| `pending()` / `acknowledge(query)` | Recover caller-owned commands and retire browser reservations after saving evidence. |

Targets contain `repo` and the snapshot's `revision`. Operations are `delete-branch`, `delete-worktree`, `release-worktree`, `delete-untracked-branches` and `refresh-remotes`. Deletion retains expected commits, cleanup retains expected HEAD and the explicit force choice. The host rechecks checkout identity and existing Git protections inside the serialized operation path. Default/current/checked-out branches and active or recovery-blocked worktrees remain protected. A plugin cannot replace these checks with its own confirmation.

`release-worktree` retains `path`, `expectedCommit` and `expectedBranch`. It detaches an idle linked worktree at the same commit, preserving its directory, branch, tracked changes and untracked/ignored files. Release controls use the existing `deletionBlockedReason`, branch and worktree flags; snapshots keep the original version-1 field set for older SDK parsers. Primary/configured, locked, missing, detached, active and recovery-blocked worktrees cannot release; an in-progress Git operation also blocks release. The operation uses the same authorization, revision checks and durable receipts as deletion.

## Confirmation and uncertainty

Show the exact targets before requesting deletion. Unmerged branch deletion requires an explicit force choice; bulk cleanup displays its candidate list before confirmation. Read refresh and cleanup preview must not imply consent to delete or fetch remote state.

One unresolved command per caller/galleon prevents a new intent from replacing uncertain evidence. The host records a durable receipt before the first filesystem effect. Git changes and SQLite receipts are separate durability boundaries: a crash or ambiguous result remains `recovery-required`, without automatic replay. Active commands return `pending` and cannot be acknowledged as complete.

There is no retry method. `inspect` uses the journal's exact retained command. If no dispatch exists, the inspection receipt prevents a delayed original request from dispatching afterward. Inspect the checkout, save the result/inspection evidence, then explicitly acknowledge before issuing a later independent command. A receipt lookup remains read-only. Disposal, scope changes, disabled packages and restart preserve original command evidence.

## Independent package

Copy `plugin-sources/local-git`, rename the package manifest and its initial-layout contribution IDs, and build with the distributed `@helmsman/plugin-sdk`. Keep the slot and panel contract IDs. Select the installed page with:

```sh
npm run plugins -- select helmsman/local-git-page example.local-git/page
```

Missing or disabled selected contributions preserve saved layouts and remain unavailable. The old `/api/repo/local` endpoint is retired in normal application mode. Core retains checkout validation and Git execution; this service does not expose arbitrary commands or filesystem paths chosen outside the validated checkout.

See [package operations](plugin-packages.md), [panel authoring](panel-authoring.md), and the [implementation ledger](plugin-implementation-progress.md) for validation and delivery status. Acceptance performs Git mutations only in isolated temporary fixtures.

## Automatic startup cleanup

Startup cleanup requires an exact retained workspace and galleon binding, a terminal eligible run, and a currently registered direct child of that galleon’s managed `.worktrees` directory. It checks the Git common directory and tracked, untracked and ignored changes before removal, and never forces deletion. Unknown paths, unrelated developer checkouts and dirty workspaces remain in place. A directory name alone does not establish ownership.

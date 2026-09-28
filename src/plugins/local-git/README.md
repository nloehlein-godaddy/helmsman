# Local Git frontend package

The SDK-only Local Git page mounts one replaceable panel through `helmsman/local-git-page`. The panel implements `helmsman/local-git-panel@1` and uses the injected `helmsman/local-git@1` service. Its runtime imports only package-local modules and SDK types.

The panel preserves local branch/worktree lists, remote tracking status, active-worktree protections, explicit branch/worktree deletion and branch release confirmations, and bulk cleanup preview. Header scope is authoritative unless the operator changes the standard composition scope. All requires selecting a repository; the panel never chooses an arbitrary checkout.

Release branch detaches an idle linked worktree at the same commit and preserves its directory and files. Confirmation pins the worktree path, branch, commit and checkout revision; active and recovery-blocked worktrees remain protected.

Refresh reads local state. Fetch remote status is an explicit journaled operation. Cleanup preview reads the exact checkout revision and selected force mode; confirmation retains that revision, HEAD, candidates and expected commits. Changes to the force option invalidate the preview. Destructive confirmations remain pinned through polling and reset on activity/scope changes. Unmerged deletion requires a separate explicit opt-in.

Unknown outcomes retain the original command in the public journal. Mount, refresh and polling never repeat commands or acknowledge receipts. An explicit receipt check saves terminal evidence before acknowledgment. Recovery-required or absent receipts expose explicit inspection, which fences delayed original delivery without repeating the operation; inspection evidence is saved before acknowledgment. Acknowledging uncertainty never claims the operation completed. Completion from an old scope is retained under its original request and cannot replace the current checkout view.

Immutable receipts and inspection evidence use the actual mounted contribution and instance identity. Routine snapshots, cleanup previews and force preferences are not persisted. Unsupported stored evidence remains unchanged and blocks further operations. Visibility/disposal cancels active reads and previews. Polling preserves force controls, focus and list scroll.

Build from this directory with `npm run build`. From the repository root, run `npx vitest run src/plugins/local-git/page.test.ts src/plugins/local-git/panel.test.ts src/plugins/local-git/render.test.ts`. Package tests use mocked public services and perform no filesystem mutations.

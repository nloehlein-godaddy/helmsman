# Latest OG integration — 2026-09-28

Source: `nathanloehlein/helmsman-og`, active `pre-rewrite` branch at
`0bc78f8` (fetched 2026-09-28). Its default `main` still points at `4ca712a`, the
previous comparison baseline. All 16 newer commits on `pre-rewrite` were assessed.
Target: plugin Helmsman, starting at `bf0e81b`, retaining version 0.4.0 and `↻` tabs.

## Commit disposition

| OG commits | Result in plugin Helmsman |
| --- | --- |
| `6c03e27`, `121949d` | Authored PR approvals, change requests, and comments were already ported through the GitHub provider and public PR read contract. |
| `f8d74f3` | Firefox bridge startup controls are superseded by the requested direct MCP/OI integration. The independently selectable legacy browser provider remains operator-managed; core does not auto-start or adopt a browser session. |
| `1136c7e`, `8d993a0` | PR rows use a responsive grid; explicit selection buttons keep links independent. Slack submission/status remains in the Communication plugin, preserving its durable command identity. |
| `9e205c5` | Scoped review materiality and advisory rare-edge guidance already exist in managed review prompts. |
| `2341e3c` | Managed local/container inference already routes through GoCaaS. This integration also removes new Copilot requests; existing immutable Copilot obligations retain recovery. |
| `ba71dc6`, `59d0321`, `7d4eab2` | Added optional direct-MCP Slack user OAuth through the provider, with Connect/Check/Disconnect controls, private credential storage, token refresh, disconnected admission guards, and only `channels:read`, `chat:write`, `search:read` user scopes. |
| `d4987c3` | Run tabs show status and review recommendations; already-open inactive tabs refresh summaries without reading their logs. Keyboard focus survives status changes. |
| `f9ba17f`, `bc92817` | Explicit continuation reruns incomplete reviews with new immutable stage evidence. Publication checks original COMMENT and resumed APPROVE against the exact revisions. Explicit legacy prompt upgrades are recorded; captured plugin artifacts remain pinned. |
| `530b961` | Local Git releases an idle worktree's checked-out branch by detaching it, preserving its files and local edits. Active and retained execution ownership blocks release. The action uses existing authorization, durable receipts, and recovery. |
| `e6f509f` | Existing-PR feedback prompts inventory all findings, require individual GitHub dispositions and a coverage summary, and retain publication authorization boundaries. Read-only/pre-PR restrictions remain unchanged. |
| `0bc78f8` | Bare PR numbers resolve against the header galleon; full URLs and qualified references keep explicit targets. No implicit choice when no galleon is selected. |

Earlier planned assign-self, tracker feedback, and same-galleon parallelism remain
separate future batches; they are not introduced by these newer commits.

## OAuth behavior and limits

The optional SDK account contract is provider-neutral. Core authorizes callers,
fences displayed provider revisions, binds a secure short-lived cookie and one-use
state to the selected artifact, and checks authority immediately before credential
commit. Provider code owns Slack consent, token exchange, verified refresh, and
private atomic storage. Concurrent disconnect/new authorization invalidates old
completions. An old callback cannot erase a newer flow's cookie.

Host polling and recovery dispatch refresh an expired grant before synchronous
connection checks. Disconnect invalidates the connection without falling back to
`SLACK_MCP_TOKEN`, so pending automatic reviews cannot silently resume with another
credential. New account grants do not retarget previously retained sends.

Interactive OAuth requires an approved Slack app and an exact HTTPS callback on
an operator-controlled endpoint. This integration does not obtain app approval or
change the existing OI deployment: OI still needs native tool approvals enabled.
All acceptance calls use fixture OAuth/MCP services; no real Slack messages or user
workloads were launched.

## Validation

- The combined changed-file gate passed 505 tests across 29 files, covering
  account/provider contracts, UI, routing, publication, continuation, runner, and
  Local Git. Follow-up compatibility corrections receive focused checks.
- TypeScript and production distribution build, including the frozen SDK
  compatibility gate. The Local Git operation union has a narrowly scoped tested
  compatibility projection; the baseline is unchanged.
- Installed copied-package tests cover PR presentation, shared run presentation,
  Local Git release/restart recovery, direct MCP, optional OAuth, and guarded OI.
- OAuth browser acceptance proves connection, persisted grant after restart,
  expired-grant recovery with automatic watching disabled and no account UI,
  explicit disconnect, credential redaction, and no fallback. Desktop/mobile
  screenshots were inspected. Direct-MCP and OI acceptance also pass.
- Independent implementation and integration reviews corrected tab focus identity,
  callback authority/cookie races, expiry refresh before host selection, and
  old-SDK Local Git snapshot parsing.

_Helmsman · not reported - not reported_

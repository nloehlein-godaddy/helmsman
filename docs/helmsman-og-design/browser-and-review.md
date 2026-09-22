# Firefox browser provider and authenticated-own-PR guard

**Scope:** design only, based on `helmsman` `edd5a8a` and OG `4ca712a`. No implementation, build, browser, Slack, or GitHub side effects were run.

## 1. Ship Firefox as an independent native-terminal package

Create `src/plugins/native-firefox/` as a backend-only package with the same author/distribution shape as `terminal-cmux`:

- package ID `helmsman.native-firefox`, local contribution `firefox`, provider ID `helmsman.native-firefox/firefox`;
- `backend.provides: [{ id: "helmsman/native-terminal", version: 1, localId: "firefox" }]` and `nativeTerminals.firefox.access: ["native-session"]`;
- `backend.ts`, `provider.ts`, `firefox-bidi.ts`, package-local tests, `tsconfig.json`, `build.mjs`, `package.json`, `plugin-package.json`, and README;
- imports only `@helmsman/plugin-sdk`, Node built-ins, and package-relative modules. It must not import `server/helmsman`, another plugin, or app source.

The sole setting is `webdriverEndpoint` (string, default `http://127.0.0.1:4444`, bounded like the cmux socket/binary settings). Validate it before any request: `http:` only; host exactly `127.0.0.1`, `localhost`, or `[::1]`; no credentials, path other than `/`, query, or fragment. The WebDriver `POST /session` request asks for Firefox plus `webSocketUrl: true`, bounded timeouts, and no implicit wait. Validate the response before opening BiDi: nonempty session id; capability `browserName === "firefox"`; `ws:` URL with a loopback host and no credentials/query/fragment. Do not follow redirects.

The provider's `metadata` is `{ version: 1, label: "Firefox", browser: true }`. It registers a full `NativeTerminalProviderV1`, although it intentionally is not a terminal:

| Contract surface | Firefox behavior |
|---|---|
| `listTabs` | Use `browsingContext.getTree({ maxDepth: 0 })`; expose only top-level contexts as opaque `firefox:<encoded-context>` surfaces. `type` is `browser`, `cwd` is `null`, and window/workspace IDs are stable opaque Firefox values. Rebuild the context map on every tree call and reject malformed, duplicate, or over-limit data. |
| `sessionIdentity` | A synchronous opaque value from canonical endpoint + activation generation + current validated WebDriver/BiDi session generation. It is stable while those values are unchanged. |
| `readScreen`, `send`, `sendKey` | Return `{ ok: false, error: "Firefox does not provide terminal screen or input controls." }`. They never emulate a terminal, start a shell, or throw a successful terminal capability. |
| `browser.tree` | Return the normalized tree used by core; include URL and virtual selected surface so core can discover the Slack target. |
| `browser.focus` | Validate a reference discovered by the latest tree and update only the provider's virtual selection. Firefox BiDi has no needed safe background-tab activation primitive here, so this must not foreground a tab, window, or browser. |
| `browser.evaluate` | Evaluate only in a known discovered context, with `awaitPromise: true`, `userActivation: false`, JSON-only result ownership, and bounded response/time. Core remains responsible for the Slack workspace/origin wrapper. |
| `browser.click` | Re-read a visible, connected, enabled target; scroll it into view; calculate an in-viewport center; require `elementFromPoint` to hit that target; then issue exactly one BiDi mouse move/down/up action. |
| `browser.fill` | Use the native input/textarea setter plus `input` and `change`, or a bounded contenteditable selection/insert path. Reject readonly, disabled, invisible, or changed targets. |
| `browser.wait` | Poll the same visibility/connectedness predicate until the SDK-bounded deadline. |

`focus` is retained-surface selection, not operating-system focus. This preserves the user's active Firefox context while core's `createCommunicationBrowserSession` still accepts only a tree-discovered Slack surface and enforces its selected/configured surface checks.

### Session and restart rules

The package owns a small BiDi client with one monotonic generation. It increments the generation and clears context/virtual selection whenever the WebSocket errors/closes, a BiDi request times out or violates protocol, WebDriver session creation fails, the configured endpoint changes on a new activation, or package disposal begins. It does **not** silently reconnect inside an already-started browser operation.

The effect of those rules is deliberate:

1. A Firefox/bridge restart before a new scan or delivery may create a new session. The new operation calls `tree()` again and discovers fresh opaque references under a new identity.
2. A restart while `createCommunicationBrowserSession` is executing changes `sessionIdentity()`. Its before/after checks reject the operation. The provider invalidates cached context IDs rather than mapping them into the replacement session.
3. A transport failure after the one pointer action is an ambiguous result. Return an error, let the higher durable communication command mark delivery uncertain, and never replay the pointer action automatically. The same rule applies if the response to `input.performActions` is lost.
4. `onDispose` closes the BiDi socket and advances the generation. A retained obligation loads the exact retained package/settings through `loadRetainedNativeTerminalProvider`; it never falls back to the newly selected browser provider.

This matches the existing core boundary: `createCommunicationBrowserSession` captures an identity, permits only tree-known/matching Slack surfaces, and checks identity and caller cancellation before and after every browser primitive. `communication-runtime` separately retains the selected browser binding/settings/surface in the communication transport. An endpoint setting, selected-browser revision, package artifact, or session change must therefore fail the current operation; none is a reason to retarget or resend it.

### Registration and selection

Keep terminal and browser selections independent. Firefox is selectable with:

```
helmsman plugins select-browser-host helmsman.native-firefox/firefox
```

It must not become the terminal default and must not replace the current default browser host automatically. `select-browser-host` writes only `native-terminal-selection-v1:browser`; `select-native-terminal` continues to write `:terminal`. Selection changes produce a new revision, and `resolveNativeTerminalSelection`/`assertNativeTerminalSelectionCurrent` fence in-flight scans and admissions.

For the shipped build, add this package to `builtinNativeTerminals` in `server/helmsman/plugins/builtin-terminals.ts`, importing its package-local backend and declaring the same manifest/settings as `plugin-package.json`. That is the only core registration needed. The package must still build independently: a copied source package with a nonreserved ID and correspondingly renamed provider ID can be packed, installed, enabled, and selected without the builtin registry. Update `docs/native-terminal-authoring.md`, the Firefox package README, the shipped-provider list, and plugin/distribution source manifests to describe endpoint setup and the two independent selections.

### Required tests

- Package-local provider tests: endpoint/BiDi URL rejection, malformed session/tree/result rejection, cancellation/timeouts, context invalidation, virtual focus, terminal methods explicitly unsupported, fill/click target checks, exactly one pointer action, and lost pointer acknowledgement without replay.
- Core tests: install/enable/select Firefox for `browser` while retaining a separate terminal selection; disable/restart/selection revision rejection; retained transport resolves the original package and does not follow replacement selection; stale surfaces/session identity abort browser session operations.
- Independent-author test: copy/build/package with only released SDK dependencies, rename it to an external ID, install/enable/select it, and exercise registration. This test must prove it has no source-tree/private-server imports.
- Distribution test: verify the builtin appears in the packaged catalog and can be selected, while the default remains cmux. Add a manually run Firefox smoke test for real WebDriver/BiDi tab discovery, background Slack selection, one click, restart fencing, and an ambiguous click with no resend. Static mocks do not establish Firefox interoperability.

## 2. Authenticated ownership guard for automatic Slack reviews

Do not use `PullRequestInspectDetailV1.isOwnPr` for this decision. Its contract explicitly means `configuredAuthor`, which is correct for current manual review-request eligibility but can differ from the GitHub credential actor. Do not add a direct `fetch('/user')` or legacy GitHub helper in the watcher.

Use the selected pull-request provider under a retained read capture:

1. Capture the current PR provider with `captureTriggerPullRequest(signal)`: selected provider binding/artifact/settings, connection id/credential handle, resolved registration, configured scope, and `pullRequestReadContext` fences.
2. Read `provider.profile(capture.context)` and `provider.detail({ version: 1, repo, number }, capture.context)` through that same capture. The GitHub provider already maps `profile()` to authenticated `/user`; its detail has `authorLogin` and the exact target head.
3. Run `capture.assertCurrent()` before starting and after every await. It already verifies selected provider binding, enabled admission registration, repository scope, connection/credential authority, token/author configuration, and provider settings. Compare `detail.target.headSha` with the persisted proposal `headSha`, and require `open` plus non-draft again.
4. Normalize nonempty authenticated `profile.login` and `detail.authorLogin` case-insensitively. Equal means `own`; unequal means `other`; a missing/invalid profile method, missing login/author, unavailable provider, changed head, or any failed fence means `unknown`.

The automatic path is conservative: only `other` may launch. `own` is blocked. `unknown` stays queued and is retried by a later poll. `configuredAuthor` and `detail.isOwnPr` are deliberately absent from this calculation. Manual communication review requests retain their existing configured-author rule unless that separate product policy is intentionally changed.

### Queue and persistence contract

Add a separately owned policy-evidence table keyed by notification ID; do not change the existing compat.slack v1 migration checksum. Its bounded record is, for example:

```
{
  version: 1,
  kind: "authenticated-pr-owner",
  decision: "own" | "other" | "unknown",
  actorLogin: string | null,
  authorLogin: string | null,
  headSha: string,
  providerBindingHash: string,
  sourceRevision: string,
  observedAt: string,
  reason: string | null
}
```

It contains no token, headers, or raw provider response. `providerBindingHash` identifies the captured binding/settings; `sourceRevision` and `headSha` prove which queued proposal was observed. Join it to the notification on read, parse it defensively, and preserve compatibility for rows without it. Legacy rows without retained proposal/provenance cannot bypass ownership verification and must remain blocked/unavailable.

For each queued communication-trigger row, use this state machine:

| Preconditions/result | Durable transition | Dispatch behavior |
|---|---|---|
| Provenance/source no longer matches, PR missing/head changed/closed/draft, repository removed | `blocked` with its existing explicit reason; release trigger pins | Never launch. |
| Capture/profile/detail/fence unavailable | remain `queued`; save `unknown` record and retryable reason; keep pins | Never launch this poll. |
| Authenticated actor equals PR author | `blocked`; save `own` evidence and “Automatic Slack review skipped: PR is authored by the authenticated GitHub account”; release trigger pins | Terminal automatic-policy decision; restart preserves it. A newly posted Slack event has a new row and is evaluated afresh. |
| Authenticated actor differs and all current fences pass | save `other` evidence, then dispatch | Eligible only after the final claim/current checks below. |
| Launch error after launch was attempted | current failed/uncertain launch behavior | Do not automatically retry an ambiguous launch. |

Use a dispatch claim to serialize the final transition. The safe sequence is: do the read-only ownership observation; assert its capture; claim the still-queued row; synchronously reassert trigger/source/provider authority; atomically verify the claim + row `status === queued` + original `runId`; then persist the policy decision or launch. Add claim-aware conditional store mutations rather than calling unconstrained `updateNotification` after an asynchronous check. On startup/poll recovery, clear an orphaned claim only after proving that the queued row has no durable run and is not active; if a run exists, promote it to `launched` first. This avoids both a second launch and a permanently wedged pre-dispatch claim.

For a captured trigger row, retain/release plugin pins with the state transition: retain when the scan inserts the row; retain during queued/unknown; release after a terminal own/source block or after a durable run is observed. Do not release merely because a profile request timed out.

The existing `verifyReviewProposal` must become an ownership-capable read path or return an immutable observation so the watcher does not independently reconstruct authority. A practical internal helper is `observeAutomaticReviewOwnership(proposal, trigger, signal)` that captures the trigger review source and its PR capture once, validates the trigger provenance/proposal hash/source revision, obtains profile+detail through that capture, and returns `{ decision, evidence }`. It must not use the Profile HTTP route: that route authorizes UI callers and re-captures global state, whereas the watcher needs the exact provider/connection capture it will use for dispatch.

### Required tests

- GitHub provider: `profile.login` normalization and invalid/missing `/user`; distinction between configured author and authenticated actor.
- Watcher: own PR posted by anyone blocks; configured author equal but authenticated actor different launches; authenticated actor equal but configured author different blocks; unknown profile/detail keeps queue and retries; updated/closed/draft PR blocks; no direct GitHub helper is invoked.
- Async fences: change provider selection, artifact/settings, connection/credential config, trigger selection, source revision, allowed repository, or head SHA while profile/detail is pending. Each must prevent both policy mutation and launch.
- Queue durability: restart after `own`, `unknown`, claim-before-decision, and launch-before-status-update; reclaim only a proven no-run claim; pins survive retry and release only on terminal transitions.
- Existing manual review-request tests: demonstrate that their configured-author eligibility remains unchanged, making the policy split explicit.

_Helmsman · gpt-6 - high_

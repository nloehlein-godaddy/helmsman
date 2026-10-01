# Run inspection service

`helmsman/run-inspect@1` supplies the authored Runs, shared viewer and history packages. Their independent installation, shared-session lifecycle and replacement acceptance are complete. Browser downloads use the implemented [download service](download-authoring.md), with explicit result and cancellation limits. Existing `helmsman/run-read@1` consumers, routes, cursor behavior and text bounds remain unchanged. See [run presentation authoring](run-presentation-authoring.md) and the [implementation ledger](plugin-implementation-progress.md).

Declare the service requirement and use `context.services.runInspect`. Import public types such as `RunInspectServiceV1` from `@helmsman/plugin-sdk`. Runtime imports of application files are unnecessary. Methods return `available` with validated, frozen DTOs or `unavailable` with a bounded reason. Lifetime, activity and caller cancellation reject with an abort error instead of producing a stale result. This facet has no watchers; a package owns cancellable polling through its activity lifecycle.

## Resolution and history

```ts
const inspect = context.services.runInspect;
if (!inspect) throw new Error('Run inspection is unavailable.');
await inspect.resolve({ version: 1, runId }, signal);
await inspect.history({
  version: 1, repo, kind: 'all', limit: 25, cursor: null,
}, signal);
```

Resolution uses the panel's effective scope, returning `{ version, target: { repo, runId, expectedAttempt }, observedAt }`. Missing and foreign-scope runs both return `not-found`; the browser never searches an unrestricted run list. Concrete panel scope cannot be widened to All or another galleon. The server independently checks configured galleons.

Run summaries optionally include `title`, a bounded retained task or review subject. It is historical launch metadata, not a fresh PR title; absent or malformed retained titles are omitted. Run history identifies generic review entries by PR number, shows their retained subject when available, and links through the selected PR page while preserving the header scope. Newly launched reviews retain the PR title already fetched during preparation. Older reviews whose subject was not retained remain identifiable by PR number and galleon. Nonreview display keys remain unchanged.

History accepts `all`, `running` or `terminal`, with limits from 1 to 100. It returns the existing public run summaries plus `nextCursor`, `total`, `totalQuality`, `observedAt` and `coverage: 'insertion-bounded-current-state'`. Worker success, review outcome and source settlement remain separate. The current server supplies an exact count; the contract permits `total: null` only with `totalQuality: 'unknown'`.

Count and rows use the same scope/status predicates, insertion ceiling and database transaction. Count excludes the page's keyset boundary: it describes the whole matching bounded collection at that observation, not the remaining or loaded rows. Later inserts, including backdated inserts, stay outside the cursor's ceiling. Existing statuses and sort fields can change between pages, so totals and traversal membership can change. This is not an immutable historical snapshot. Refresh from a null cursor to start a new observation.

Signed cursors bind the effective query, permitted galleons and service lifetime. Changed scope/filter, tampering or server restart makes an old cursor unusable. Do not display a loaded-row count as the history total or derive an offset from mutable membership.

## Run-wide preview and follow

```ts
const inspect = context.services.runInspect;
if (!inspect) throw new Error('Run inspection is unavailable.');
const result = await inspect.log({
  version: 1, target, direction: 'backward', limit: 50, cursor: null,
}, signal);
```

Each target contains the canonical galleon/run ID and `expectedAttempt`. That attempt is a concurrency fence, not event attribution. Stored events have no attempt column; every page explicitly declares `provenance: 'run-wide'`, including events retained from earlier attempts.

The first backward request captures an event watermark and returns the latest bounded page in ascending sequence order. `nextCursor` reads older pages under that same watermark; it becomes null when no older entries remain. Only the initial page supplies a `followCursor`. Retain that cursor independently when loading older entries.

Forward requests require a non-null cursor, initially the captured `followCursor`. They drain events after that position through one watermark before observing later appends. Their `nextCursor` stays usable even when no events are available. A later poll may capture a new watermark; backward reads never change the live-follow position.

`throughSequence` identifies the captured window. `hasEarlier` and `hasLater` describe events before/after the returned slice within that window, not whether a worker will produce future output. On an empty caught-up forward page, `hasEarlier` may remain true because historical events exist at or before the continuation position. `workerStatus` is the current worker outcome and remains separate from log text. Sequences are globally assigned IDs and need not be contiguous for a single run.

Pages contain at most 50 events; event text is bounded to 4,000 UTF-16 code units without splitting a surrogate pair. `truncated` describes display clipping only. A viewer can retain a 300-event preview through multiple bounded pages; the service does not supply an unbounded browser log buffer. Render text literally.

Cursors bind effective scope, configured galleons, exact run/attempt, direction, watermark and position. Changing the current attempt returns `attempt-changed`; rebinding a cursor returns `cursor-invalid`. Resolve the current run again and deliberately restart its preview. Do not silently label retained old events as the new attempt or reuse a cursor across direction changes.

## Streaming export

```ts
const inspect = context.services.runInspect;
if (!inspect) throw new Error('Run inspection is unavailable.');
const result = await inspect.exportLog({ version: 1, target }, signal);
if (result.status === 'available') {
  await result.value.stream.pipeTo(destination, { signal });
}
```

`destination` must be a real streaming sink. The service supplies a host-owned `ReadableStream<Uint8Array>` and metadata: canonical target, observation time, run-wide provenance, captured `throughSequence`, safe filename and `text/plain; charset=utf-8` content type. For browser downloads, use the implemented [`helmsman/download@1` service](download-authoring.md): call its `save` method from the click handler and invoke `exportLog` inside its lazy `open` callback. The destination is selected before the export watermark is captured. The sink prefers the native file picker and falls back to the scoped streaming download worker. Do not collect a complete `Blob`, string or array of chunks and describe that as bounded-memory export.

The export includes every complete stored event through its captured watermark as `[timestamp] kind: text` followed by a newline. Later appends belong to a new export. Preview clipping does not alter exported text. UTF-8 bytes, including embedded NUL and multi-byte characters, are preserved; byte chunk boundaries may divide a UTF-8 sequence, so a text consumer must use a streaming decoder.

The server reads timestamp, kind and text in at most 64 KiB byte chunks, instead of collecting whole event rows, and honors destination backpressure. It rechecks scope and current attempt before each chunk and completion. An attempt change, revoked scope or disconnect aborts the transfer; partial bytes are not a successful export. The browser wrapper retains cancellation listeners after `exportLog` resolves and cancels the response reader when the panel/caller lifetime ends, even if the consumer has not started reading. It splits coalesced network chunks into at most 64 KiB per downstream read, retaining no more than one network chunk (bounded to 2 MiB), and fetches no further chunk until that buffer is drained. Consumer cancellation propagates upstream. The 30-second response-header timeout does not limit a healthy long-running export; a stalled stream remains cancellable by its owner.

Do not expose transport URLs, response metadata headers or private run paths in authored package state. Preserve the canonical target and opaque cursors only for their documented lifetime. Disabling presentation does not stop execution or change run-command authority.

## Verification

Codec, browser-adapter, SQLite-service and real HTTP tests cover scoped resolution, truthful counts under insertion/status changes, stale/tampered/direction-bound cursors, backward/live independence, empty logs, attempt changes, Unicode/NUL preview and export, bounded reads, slow sinks and cancellation before/after response delivery. Existing run-read and legacy export regressions remain in the verification batch. Actual Chromium, WebKit and Firefox downloads and a source-denied production export-to-download test pass. Firefox can leave its native download UI pending after stream cancellation; the application does not promise to dismiss that UI. Authored viewer installation, shared-session rehoming and presentation cutover acceptance passed, including final Phase G installed checks.

_Helmsman · not reported - not reported_

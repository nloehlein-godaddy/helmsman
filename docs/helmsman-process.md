# Helmsman voyage flow

Open [helmsman-process.html](helmsman-process.html) for the standalone diagrams. They work offline and can be printed or saved as a PDF from a browser.

The flow now includes Moon Units-inspired intake, frozen execution settings, isolated agent stages, Agent Questions, durable evidence and recovery, and Costs & Outcomes. Those services surround the existing exact-revision PR review gate; they do not replace it.

## Plugin task presentation and command authority

Costs, Helm, Todos, Triage, Bugs and Source settings use public plugin services. Task aliases select their registered page implementations; core Config links to the separate Source settings page. Default task-page cutover is reviewed and pushed. E4 run inspection, bounded downloads, provisional viewer/history pages and public clarification services are reviewed and pushed as b49c6ca; shared-viewer convergence and fully authored question/contact panels are in progress; interchangeable execution/policy (F) and compatibility retirement (G) remain pending. See the [implementation ledger](plugin-implementation-progress.md).

```mermaid
flowchart TD
    Alias[Task alias] --> Selection[Selected page contribution]
    Selection -->|Disabled or missing| Unavailable[Unavailable page<br/>Retain selection and layout]
    Selection -->|Available| Layout{Saved composition exists?}
    Layout -->|Yes| Retain[Keep saved layout and opaque state<br/>Including empty and missing panels]
    Layout -->|No| Initialize[Package defaults<br/>Atomically archive and import legacy Triage preferences]
    Retain --> Scope
    Initialize --> Scope
    Scope[Header galleon or explicit panel override<br/>Exact source instance and revision] --> Panel[Selected task page and panel<br/>Host manages lifetime, scope and cancellation]
    Panel --> Reads[Public task / editor / task-view reads<br/>Bounded, validated DTOs; no credentials]
    Reads --> Provider[Jira or local source provider<br/>Declared optional views; explicit quality]
    Provider --> Display[Render independent group and metric quality<br/>Actual links, dates and scope-checked related voyages]
    Panel --> Intent[Persist original intent UUID and input<br/>Source command or run command]
    Intent --> Core[Core checks authority, scope and revisions<br/>Provider prepares; host owns mutation and receipt]
    Core --> Accepted[Verified terminal receipt<br/>Consume result and save draft, then acknowledge]
    Core --> Uncertain[Lost response or ambiguous preparation<br/>Preserve original request; reconcile same identity]
    Uncertain --> Lookup[Same-ID receipt lookup<br/>Retain original input; no blind resend]
    Lookup -->|Recovery-required source or run command| Recovery[Core Recovery and retained evidence<br/>No automatic provider rebind]
    Panel --> Admin[Source administration<br/>Revision-checked settings and schedules<br/>Process-local automatic-start state]
    Admin --> AdminLookup[Retain admin intent; same-ID lookup in settings UI<br/>Historical receipt or prior-process expiry<br/>No Core Recovery resolution]
    Legacy[Legacy Todo session journal<br/>Original method, path, payload and UUID] --> Check[Host receipt check; All-galleon scope<br/>No reissue through new source commands]
    Check --> Accepted
    Check -->|Missing authority or ambiguous evidence| Preserve[Preserve legacy journal entry<br/>No reissue; no Core Recovery resolution]
```

Triage applies provider filters before pagination and preserves independent cursors under a fixed observation window. Its related voyages are enriched from canonical task claims and checked against actual runs in the selected galleon. Editor associations instead come from the provider; core verifies run existence and galleon scope without asserting claim ownership. Bugs labels approximate counts, unknown metrics and capped resolution samples separately. A source or presentation disablement denies new work while retained execution and effect obligations stay pinned. A historical automatic-start receipt never establishes the current process's enabled state. Package code is trusted; DTO and import validation do not provide a security sandbox.

## E4 foundation: run inspection and streamed downloads

This flow describes the reviewed and pushed E4 foundation. Authored viewer/history packages are available through provisional slots; the legacy `/runs` page still awaits cutover.

```mermaid
flowchart TD
    Panel[Active panel and effective galleon scope] --> Inspect[Public run-inspect service]
    Inspect --> Resolve[Resolve canonical run and expected attempt]
    Resolve --> History[Bounded history with observation-time count]
    Resolve --> Preview[Run-wide log preview<br/>Attempt and direction bound cursors]
    Preview --> Older[Older pages retain captured watermark]
    Preview --> Follow[Follow drains captured watermark<br/>Then observes later appends]
    Resolve --> Sink[User requests download<br/>Host selects destination before opening source]
    Sink --> Picker[File picker when available<br/>Wait for destination acceptance]
    Sink --> Browser[Scoped service worker fallback<br/>Prepare one-use download token]
    Picker -->|Accepted| Export[Open source and capture export watermark<br/>Stream complete stored text in bounded byte chunks]
    Browser -->|Ready| Export
    Export --> Transfer[Write with backpressure<br/>Wait for destination demand]
    Transfer --> End{Destination kind}
    End -->|Picker| Saved[Saved only after writable close succeeds]
    End -->|Worker| Delivered[Delivered to browser<br/>Disk save is not confirmed]
    Inactive[Hidden, disposed or changed scope] --> Abort[Cancel source and sink streams]
    Abort --> Export
    Abort --> Sink
```

Log events remain run-wide because stored events have no reliable attempt provenance. An expected attempt prevents stale reads and exports; it does not attribute old events to that attempt. History totals describe the current observation within an insertion ceiling, not an immutable status snapshot. The browser fallback avoids a full-log Blob; Firefox stream cancellation does not guarantee an immediate native download failure indication. See the [E4 implementation plan](plugin-phase-e4-implementation.md) for clarification channel, durable-answer and replacement-package acceptance gates.

## E4 working slice: presentation and durable answers

These flows describe the current integration work. The existing `/runs` drawer and PR renderer remain pending cutover; clarification presentation retains an explicitly tracked compatibility bridge.

```mermaid
flowchart TD
    Selection[Active plugin page or panel selects typed run identity] --> Scope[Capture effective galleon scope<br/>Header stays unchanged]
    Scope --> Slot[Resolve selected run-viewer page slot]
    Slot -->|Missing or disabled| Unavailable[Show unavailable<br/>Keep saved layout and state]
    Alias[Standalone viewer alias] --> Slot
    Canonical[Canonical viewer route] --> Exact[Resolve exact contribution without fallback]
    Exact -->|Missing or disabled| Unavailable
    Exact -->|Available| Auxiliary
    Slot -->|Available| Auxiliary[Reuse shared standalone and auxiliary composition session]
    Auxiliary --> Viewer[Authored viewer owns tabs, log window,<br/>command journals and download controls]
    Auxiliary --> Move[Rehome same DOM session<br/>Restore focus and text selection]
    Move --> Transfer[Synchronous transfer retains active reads and requests]
    Auxiliary --> Hidden[Hidden or detached<br/>Abort scoped work; retain session]
    Hidden --> Visible[Visible again<br/>Resume from retained package state]
    PR[Typed PR selection] --> LegacyPR[Existing private PR page<br/>Separate compatibility panel awaits cutover]
```

```mermaid
flowchart TD
    Draft[Question answer or global contact draft] --> Reserve[Reserve request identity durably<br/>Keep changed unsent draft separate]
    Reserve --> Submit[Enabled declared contribution<br/>Exact input and effective scope]
    Submit --> Prior{Stored receipt for same caller and request?}
    Prior -->|Same input| Replay[Return retained result]
    Prior -->|Different input| Conflict[Reject identity reuse]
    Prior -->|No receipt| Transaction[One SQLite transaction]
    Transaction --> Question[Answer: current run, stop intent, deadline,<br/>attempt/channel and question revision]
    Transaction --> Contact[Global contact: reserved identity or revision CAS]
    Question --> Result[Mutation or rejection + terminal receipt<br/>Receipt failure rolls back mutation]
    Contact --> Result
    Result --> Save[Consumer durably saves result and draft state]
    Replay --> Save
    Save --> Ack[Acknowledge browser journal<br/>Server retains receipt]
    Ack --> Cleanup[User chooses individual saved draft or result cleanup]
    Save -->|Storage full or unavailable| RetainResult[Keep terminal receipt and drafts]
    RetainResult --> Cleanup
    Cleanup --> ReadJournal[Read both current journals successfully]
    ReadJournal --> Protected{Associated unresolved submission?}
    Protected -->|Yes| Keep[Keep saved evidence]
    Protected -->|No| Unchanged{Selected draft still matches displayed and saved content?}
    Unchanged -->|Changed| Keep
    Unchanged -->|Already unsaved at selection| Local[Discard only selected local edit<br/>Reload and retain persisted draft for review]
    Unchanged -->|Unchanged saved draft or immutable result| Remove[Delete only selected draft or saved result<br/>Global contact draft is labeled separately]
    ReadJournal -->|Read failed| Keep
    Remove --> Journals[Command journals remain unchanged]
    Remove -->|Retry retained result save| Save
    Submit -->|Response lost| Pending[Keep original reserved command<br/>User checks receipt or retries exact input]
    Pending --> Submit
    Legacy[Unknown question provenance] --> ReadOnly[Visible and read-only<br/>Required unanswered obligation still blocks publication]
```

Saved browser drafts and results remain until explicit cleanup. Fresh successful journal reads protect records associated with unresolved submissions; a read failure prevents deletion. Cleanup checks the displayed and saved draft again after the journal read and rejects changed content. Discarding an already-unsaved local edit retains and reloads persisted text for review; deleting that text requires a separate action. Scoped answer drafts, saved results and the explicitly global contact draft have separate removal actions, and none deletes journal entries. Compatibility local storage does not provide an atomic transaction across tabs for the final comparison and deletion.

Answer acceptance does not prove worker consumption. Contacts are global metadata; saving them sends no messages. Disabled contributions retain browser journals and reconcile after reenablement. Legacy HTTP ingestion, ID-only answers and unversioned contact writes return 410 when the public services are active. Trusted worker ingestion still requires its retained attempt channel. See [backend contracts](clarification-backend.md) and [author lifecycle](panel-authoring.md).

## Conditional panel-state saves in development

The next E4 slice adds conditional panel-state saves for authored question/contact panels. These changes are local until their independent package and production acceptance gates pass:

```mermaid
flowchart TD
    Edit[Draft or terminal command result<br/>Retain exact observed saved-state baseline] --> Capture[Copy bounded expected and next state]
    Capture --> Read[Read current composition]
    Read --> Compare{Caller-owned state matches baseline?}
    Compare -->|No| Conflict[Keep stored state and local edits<br/>Refresh observed state; explicit reconciliation]
    Compare -->|Yes| Commit[Atomic layout revision check and save]
    Commit -->|Concurrent write| Conflict
    Commit -->|Saved| Result[Consumer retains durable result and draft]
    Result --> Ack[Explicit acknowledgment of original journal request]
    Missing[Host lacks optional compareAndSetState] --> Preserve[Disable writes and acknowledgment<br/>Retain original requests]
```

## Intake and execution preparation

```mermaid
flowchart TD
    Manual[Operator selects a galleon<br/>Jira ticket, custom task, local todo or existing PR] --> Dispatch
    Campaign[Campaign: create phases<br/>CSV/JSONL preview → confirm → start phase<br/>Import and task deduplication] --> Dispatch
    Webhook[GitHub webhook, when configured<br/>Raw-body HMAC + explicit event/action/workflow mapping<br/>Persistent delivery deduplication] --> Dispatch
    Dispatch[Check scope and capacity<br/>One active writer per galleon<br/>Automated dispatch uses durable claims] --> Snapshot[Freeze workflow version, prompts, skills and settings<br/>Verify required skills and provision private copies<br/>Retry/resume must match the saved snapshot]
    Snapshot --> Host{Configured execution host}
    Host --> Local[Trusted local execution<br/>Default host]
    Host --> Docker[Docker agent stages<br/>Pinned image; private workspace and runtime<br/>Run-scoped gateway; host keeps upstream credentials]
    Local --> Workflow{Task workflow}
    Docker --> Workflow
    Workflow -->|New coding task| Coding[Implementation and exact-revision review loop below]
    Workflow -->|Existing PR review| Review[Pin PR head and run standalone review<br/>Host verifies result and required answers before posting]
    Snapshot -.->|Missing skills / drift / unavailable host| Block[Fail preflight; no unisolated fallback]
```

Manual launches inherit the header galleon unless a panel explicitly selects another. Campaign record overrides are shown in the import preview; webhook targets and workflows come only from configured mappings. Campaign phases control dispatch and concurrency; durable claims and stable run IDs allow reconciliation after uncertain launches.

In Docker mode the host supervises, verifies artifacts, and publishes; only writer/reviewer stages enter containers. Agent containers reach approved provider operations and restricted GitHub reads through a capability-scoped gateway. They receive no long-lived host credentials, unrestricted internet access, or Docker socket. Trusted local execution retains its existing host permissions.

## Coding and PR publication

```mermaid
flowchart TD
    Prepared([Coding workflow prepared]) --> Context[Load task context and prepare workspace<br/>Managed branch; validate base, remote and clean checkout<br/>Writer CLI available in selected execution environment]
    Context --> Writer[Writer implements and runs checks<br/>Commits locally and writes PR metadata]
    Writer --> Review[Review round: sequential CLI leads<br/>Writer CLI first, then installed alternate<br/>Each lead is prompted to delegate focused sub-agents]
    Review --> Reports{Reports valid for the pinned SHA?}
    Reports -->|Otherwise valid; summary over 2,000 characters| Correction[One summary-only correction attempt per report<br/>Revalidate; preserve verdict and findings<br/>Keep original report]
    Correction -->|Valid| Gate{Every selected reviewer approves<br/>with no findings?}
    Correction -->|Invalid or failed| Stop[Block publication<br/>Preserve work and report artifacts]
    Reports -->|Valid| Gate
    Reports -->|Malformed, stale or changed worktree| Stop
    Gate -->|COMMENT / incomplete review| Stop
    Gate -->|REQUEST_CHANGES; rounds remain| Fix[Writer fixes deduplicated findings<br/>Runs checks and commits a new revision]
    Fix --> Review
    Gate -->|Findings at final round| Stop
    Gate -->|Yes| Answers{Required Agent Questions answered?}
    Answers -->|No / gate unavailable| Stop
    Answers -->|Yes| Push[Host rechecks approved revision<br/>Push exact approved commit]
    Push --> Verify[Verify remote SHA and PR base/head]
    Verify --> Publication[Recheck required answers before PR write]
    Publication --> PR[Create and verify PR<br/>Or reuse matching existing PR<br/>Apply author byline]
    PR --> Queue[Queue a separate Helmsman PR review]
    Queue --> Success[Record successful voyage]
    Success --> JiraState[Eligible Jira ticket → configured review status]
    JiraState --> Copilot[Request Copilot review]
    Copilot --> Complete[Complete parent voyage and release capacity]
    Complete --> Followup[Queued Helmsman review launches when eligible<br/>Open, non-draft PR; pin current head<br/>Reuse an existing matching review when available]
    Resume[Optional valid saved checkpoint<br/>Verified artifact hashes and frozen snapshot<br/>Exact branch/base/head and original reports] -.-> Reports
```

## Services throughout a voyage

```mermaid
flowchart LR
    Channel[Fresh attempt channel<br/>Pinned with immutable execution snapshot] --> Stage[Agent stages]
    Stage --> Question[Agent asks a question<br/>Exact channel and deadline saved]
    Stage --> Exit[Verified worker exit]
    Exit --> Drain[Drain final complete question records]
    Drain -->|Unfinished non-whitespace record| Block
    Question --> Human[Agent Questions page<br/>Accept answer only for proven current attempt]
    Human --> Continue[Publish matching channel answer<br/>Agent reads answer and continues]
    Legacy[Legacy shared-file question<br/>Unknown attempt; read-only] -->|Required and unanswered| Block
    Question -->|Required answer missing, expired or cancelled| Block[Block completion and publication<br/>Timeout is never an answer]
    Stage --> Evidence[Host validates reports<br/>Immutable artifacts + content hashes]
    Evidence --> Recovery[Restart: reattach durable process/container identity<br/>Checkpoint: verify snapshot, hashes and pinned revision]
    Stage --> Usage[Structured provider events + lifecycle ledger<br/>Idempotent replay; no double-counted usage]
    Usage --> Outcomes[Costs & Outcomes<br/>Reported spend + separate Codex API estimates<br/>Usage coverage, tokens, duration, PR outcomes<br/>Separate task assessment with evidence]
```

- **Questions:** the E4 foundation pins new channels to immutable execution attempts before preparation; recovery verifies the retained channel, and continuation receives a new one. The operator can answer proven current-attempt questions. Legacy shared-file questions remain unknown and read-only; prior or unknown required unanswered obligations still block publication. Local and Docker gates verify the retained attempt/channel pair. After verified exit, a final drain captures late questions before retry or completion; unfinished non-whitespace records block progress. Waiting retains capacity. Contacts are optional suggested respondents and never send notifications. Public answer commands now retain durable receipts; the compatibility renderer uses those services. Fully authored clarification presentation and Runs/PR cutover remain pending.
- **Evidence and recovery:** validated reports are recorded with immutable identities and hashes. A checkpoint continuation revalidates saved evidence before reusing it; legacy checkpoints without manifests follow an explicit compatibility path. A fresh retry preserves the original task/provider, workflow snapshot and Docker image pin; changed prompts or skills fail preflight. Restart reattachment and checkpoint continuation are different from restarting an entire failed voyage.
- **Costs and outcomes:** provider token/cost events and stage timing feed a persistent ledger. Reported spend can be partial; unreported billed costs stay unknown. Eligible unpriced Codex usage receives a separate Standard short-context API baseline estimate, using published rates checked September 19, 2026. The UI exposes estimated/unpriced record coverage and runs without usage records. Missing model/token data remains unknown; service tier, per-request context and cache-write usage are unavailable, and subscription charges may differ. Estimates do not affect budget caps or cost-per-PR metrics, which use fully priced runs. Process success does not itself establish task completion: assessment state (complete/partial/failed/not-assessed) is separate from task outcome (achieved/partial/not-achieved/unknown), with supporting evidence. PR visibility is best-effort with explicit stale/unavailable status.

## Defaults and boundaries

- **Defaults:** 2 desired reviewer CLIs, 3 review rounds, 45 minutes per agent session. Configuration allows 1–2 reviewers, 1–5 rounds, and 5–180 minutes. These are defaults, not a statement of current live settings.
- The writer CLI is required in the selected execution environment. An unavailable alternate CLI permits a single reviewer, even when 2 are configured. The writer's review is a fresh session, using a detached worktree locally or an isolated review workspace in Docker.
- Reviewer leads run sequentially. Their prompts request concurrent, bounded sub-agents; the runtime does not verify that delegation happened.
- Each reviewer examines the same complete committed diff. After a fix commit, every selected reviewer reviews the new revision. A `COMMENT` verdict blocks; it does not enter the fix loop.
- Summary correction applies only to an otherwise valid report. It gets one additional session per report, with its own timeout, and does not consume another review round. The 2,000-character limit uses JavaScript string length, including whitespace and any byline.
- Preflight, agent, report, revision, and publication failures stop the flow. Pre-PR voyages have one outer attempt; the runtime does not automatically restart the entire voyage. Work is retained on failure. A push may already have occurred if a later publication check fails.
- A valid saved checkpoint skips implementation and reuses the original reports for its saved review round. It must match the current branch, base, head, and complete selected reviewer set. Oversized saved summaries can use the same correction step.
- After publication, Helmsman queues its own PR review and requests Copilot. Jira transitions apply to eligible Jira tasks, not local todos or freeform tasks. Queue and Copilot request failures do not change the successful creation voyage to failed.
- The queued Helmsman review waits for the parent to finish, available capacity, and GitHub configuration. Closed, merged, or draft PRs are blocked. A matching running or successful review for the current head can be reused. The flow does not auto-merge the PR.

## Setup and current limits

- Webhooks are disabled until a secret and explicit routes are configured; public ingress is a separate deployment choice. See [webhook setup](webhooks.md).
- Docker requires a built runtime image and host provider credentials. Dependencies/cache must be supplied in the image because agent stages have no unrestricted network access. Docker branch-update reruns currently fail preflight; the operator must select trusted local execution for that mode. See [Docker execution](docker-run-host.md).
- Offline Docker lifecycle and mocked provider gateway flows were verified during adoption. A real provider-backed Docker coding/review run still requires configured host API keys; the adoption validation did not make paid provider calls.
- No path auto-merges a PR. Merging remains a human action on GitHub.

Implementation references: `server/helmsman/prepare-run.ts`, `workflow-snapshots.ts`, `campaign-dispatcher.ts`, `webhooks.ts`, `docker-stage.ts`, `scoped-gateway.ts`, `clarification-runtime.ts`, `pre-pr-runtime.ts`, `artifacts.ts`, `run-telemetry.ts`, and `outcome-service.ts`. See [adoption evidence](moonunit-adoption.md).

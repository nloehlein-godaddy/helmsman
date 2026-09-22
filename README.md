# Helmsman

A control plane for coding agents working from Jira and local task sources. Launch a CLI agent against a
task, watch it work live (explore → implement → test → open a PR), and keep a human
approval gate before anything merges — running multiple agents across repos, one at a
time per repo. The dashboard (backlog queue, current run, Ship’s log, shipped PRs)
is the view; the **Helmsman server** behind it spawns and supervises the agents.

The **Helm** dashboard defaults to Quarterdeck: sea-blue panels, wood-brown trim, brass
fleet readouts, and a ship-wheel startup animation with compass bearings and course plotting.

## Status

- **Built (P0–P6):** the Helmsman server, SQLite run store, dashboard API, and agent execution — launch a ticket, run it in an isolated git worktree,
  stream its events to a live log drawer, and record the run (P0–P1); Jira status
  writes with an In-Review gate (P2); a multi-agent running view with per-run stop
  and live logs (P3); an opt-in per-repo auto-claim scheduler (P4); a generic-command
  adapter plus hardening — crash recovery, orphaned-worktree sweep, and cost/attempt
  caps (P5); and a full UI control plane — launch any ticket or a free-form task, a
  recent-runs history, and a live non-secret config editor (P6); and PR controls —
  view any PR's status/CI/review decision, approve / request-changes / comment, and
  re-run the agent on an existing PR branch with feedback (P7). The agent opens a PR
  and **never merges**.

## Plugin implementation status

Optional pages, panels and integrations use replaceable plugin contributions. Task sources, PR and communication providers, pricing, scheduling, agents, execution hosts, native terminal/browser providers, workflows and triggers have public contracts. Core retains scope, credentials, durable state, admission, budgets, concurrency, publication and recovery. Disabling a selected provider blocks new work without restoring a private fallback; saved layouts and existing obligations remain intact.

Phases A–G are complete. Optional features use public plugin contracts, obsolete new-work routes are retired, and the stable SDK includes independent-author examples and compatibility guidance. Initial acceptance passed, including the manual draft-review correction. The [second adversarial review](docs/adversarial-review-2026-09-21-round-2.md) subsequently found seven issues, including two P1s; the [second fix ledger](docs/adversarial-fixes-2026-09-21-round-2.md) records their corrections and validation. The [helmsman-og comparison](docs/helmsman-og-feature-evaluation-2026-09-21.md) identifies compatible feature updates. The [remaining-feature design](docs/helmsman-og-feature-design.md) defines the implementation batches, retained command boundaries and opt-in concurrency rollout. See the [implementation ledger](docs/plugin-implementation-progress.md) for accepted evidence and the [adversarial fix ledger](docs/adversarial-fixes-2026-09-21.md) for subsequent hardening, validation and platform limits.

The OG presentation ports add scoped Triage and Bugs descriptions, canonical Underway links to recorded runs and PRs, and accessible loading wheels in Running and Recent. The operator disclosure is in Config; Recovery and Pirate controls remain in the footer. Durable assign-self, configured feedback and opt-in same-galleon parallelism remain planned.

Start with the [independent plugin quickstart](docs/plugin-quickstart.md), [package installation](docs/plugin-packages.md), [compatibility policy](docs/plugin-compatibility.md) and [retired routes](docs/plugin-legacy-retirement.md). The [voyage flow diagrams](docs/helmsman-process.md) describe current presentation, execution and recovery boundaries. Runs, history, the shared viewer and clarification panels are authored packages; `/runs` and `/prs` select compositions using public PR panels and the same auxiliary viewer.

The [authored question/contact guide](docs/authored-clarifications.md) describes the selected `/clarifications` composition, conditional draft/result saves and its always-visible compatibility recovery link. Original drafts and pending requests remain under their original caller in the independently buildable recovery package; the alias does not import or replay them. Renamed copies use their own storage namespace and request journals. The [public PR page and provider guide](docs/pull-request-authoring.md) describes independently buildable PR presentation, replaceable GitHub integration and durable manual-review requests. `/prs` and `/pr` select an authored composition. The [Runs package](src/plugins/runs/README.md) composes the public PR and history panels; separate header, PR and run targets remain intact. The [Communication authoring guide](docs/communication-authoring.md) covers the selected `/communication` composition, notification header, scoped reads and revision-checked settings, caller-owned exact retry, durable Slack requests, and the independently buildable Slack provider.

The [Terminal authoring guide](docs/terminal-authoring.md) covers the selected `/terminal` composition and `/cmux` alias, header and explicit panel scope, revision-bound list/screen/control operations, bounded visible polling, explicit keyboard control, and durable browser/server receipts. Receipt checks never send input, and uncertain controls require inspection before the operator explicitly resumes later controls; the public service has no retry API.

The [Campaign authoring guide](docs/campaigns-authoring.md) covers replaceable campaign presentation, revision-checked mutations, explicit import previews, durable receipts and exact-request recovery. Core retains durable execution coordination; [trigger extraction](docs/trigger-authoring.md), reviewed and pushed through `12a62c9`, moves candidate ordering into a separately selected policy.

The [Local Git authoring guide](docs/local-git-authoring.md) covers scoped branches/worktrees, revision-pinned confirmations and durable command inspection without replay. Existing Config deep links select the replaceable `/local-git` page.

## Stack

TypeScript (strict). A **Vite** front end (pure logic in `src/logic/`, unit-tested with
Vitest; `src/render.ts` owns the DOM) plus a persistent **Helmsman Node server**
(`server/helmsman/`, `node:http` + `node:child_process`) that serves the API, owns a
**SQLite** run store (better-sqlite3), and spawns agents in per-run git worktrees. No
runtime framework.

## Data

Pages and panels read scoped, versioned services from their plugin context. The
Helmsman server queries the selected task-source and PR providers; Vite proxies
`/api` to that server during development. Source failures remain unavailable.
Mutating HTTP requests require `Content-Type: application/json`, a loopback Host, and an absent or matching Origin; cross-site fetch metadata is rejected before routing or body parsing. The development proxy preserves the browser Host. Signature-verified GitHub webhook intake is the sole mutation exemption.

The old `/api/dashboard`, `/api/triage`, `/api/bugs` and private PR routes return
410; use the public SDK services described in [route retirement](docs/plugin-legacy-retirement.md).

## Commands

```bash
npm install
npm run dev          # Helmsman (:43871) + Vite UI (:43872, proxies /api)
npm run helmsman     # Helmsman server only
npm run build        # production build to dist/
npm test             # vitest
```

## Background: the agent this dashboard watches

This is the UI half of a pattern for autonomous internal-dev-tooling agents —
not a customer-facing product, not a general orchestration framework. The
target use case: a coding agent that works a Jira backlog unattended, opens a
PR per ticket, and hands off to a human at the review gate before anything
merges.

This section records the original Jira-only motivation. The current runtime also owns durable execution, claims, command receipts and recovery in SQLite; local Todos own their task state there. See the current [task-source contract](docs/task-source-authoring.md) and [Recovery guide](docs/recovery.md).

### Why not LangGraph / Temporal / CrewAI / an agent framework

Those solve problems this doesn't have. Internal tooling failures are cheap —
a bad run gets retried, nobody's paged. There's no multi-tenant state to
coordinate, no cross-service durability requirement, no need for crash-safe
mid-task resume unless a single ticket routinely spans many hours. Bringing in
a framework's checkpointing/replay machinery here would be solving for
durability nobody asked for. The right amount of infrastructure is closer to
"a scheduled job plus two APIs that already track state" than "a new
distributed system."

### The actual loop

**State store = Jira, not a new database.** Ticket status *is* the state
machine — `Backlog → In Progress → In Review → Done` — and it's already the
view your human reviewers use. Don't shadow it with a parallel SQLite/Postgres
tracker; that's a second source of truth to keep in sync for no benefit.

```
heartbeat wakes (cron / Claude Code /schedule, not a standing daemon) →
  any ticket assigned to the bot still "In Progress"?
    yes → resume/retry it (never double-claim)
    no  → query the backlog (JQL, priority order, label-gated to
          "agent-eligible" so nothing sensitive gets auto-picked)
        → claim the top one, assign to bot, transition → "In Progress"
  work it: explore the repo → implement → run tests → open a PR,
  link the PR back to the ticket
  transition ticket → "In Review"
  loop back to the top, claim the next one
```

**Single-flight per repo.** Multiple tickets against the same codebase in
parallel just means merge conflicts and wasted work. Parallelize across
repos if you need throughput; serialize within one.

**The human gate is real, not cosmetic.** PR opened + ticket → "In Review" *is*
the gate — the agent never merges to main. Same read/write split this
dashboard's "Working on" panel calls out: investigation (explore, read, run
tests) is unrestricted; anything that writes — branch push, PR open — is the
only gated surface, and merge itself is always a human action.

**When this would earn a heavier framework**: tickets start requiring
multi-session work with real crash-safe resume, or you need explicit
dependency ordering between tickets (ticket B can't start until ticket A
merges — that's a dependency graph, not a queue). Until then, Jira-as-state +
a bounded per-ticket agent session is the whole architecture.

## First-time setup

1. Install **Node.js 22.12+ on the 22 release line, or Node.js 24+**, npm, and Git.
   These versions satisfy the current Vite and `better-sqlite3` requirements. If npm cannot use a prebuilt
   SQLite binary, install your platform's native build tools (Xcode Command Line Tools
   on macOS). Install and sign in to the agent CLI you intend to use: `codex` (default),
   `claude`, or the executable for the `command` adapter. It must be available on the
   Helmsman server's `PATH`. Install and authenticate GitHub CLI (`gh auth login`) for
   coding agents that open or update PRs. Git must also be able to fetch your private
   repositories using your SSH key or HTTPS credential helper.
2. From the Helmsman checkout, run:

   ```bash
   npm install
   cp .env.example .env
   ```

   Keep `.env` local. It is required by the server, even if you leave credentials blank
   to explore the degraded/demo dashboard. Run subsequent npm commands from this directory.
3. Create a parent directory for the repositories Helmsman will work in, and clone each
   repository into a directory matching its **repository name**, without the owner:

   ```bash
   mkdir -p /absolute/path/to/agent-repos
   git clone git@github.com:your-org/your-repo.git /absolute/path/to/agent-repos/your-repo
   ```

   Set `AGENTS_ROOT=/absolute/path/to/agent-repos` in `.env`. A configured repository
   `your-org/your-repo` resolves to `<AGENTS_ROOT>/your-repo`; its agent worktrees live
   under `<AGENTS_ROOT>/your-repo/.worktrees/<run-id>`. Helmsman does not clone missing
   repositories. Use an ordinary checkout with an `origin` pointing to that GitHub
   repository. Repositories with the same name under different owners cannot share
   this directory layout. Install each target project's dependencies as its own README
   requires, and verify its build/test commands before launching a voyage.
4. Configure GitHub in `.env`. Create a [personal access token](https://github.com/settings/tokens)
   that can access the selected repositories, including organization approval or SSO
   authorization where required. Dashboard reads need repository, PR, and CI-status
   read access; publishing reviews needs pull-request write access. Coding agents that
   push changes need repository-content write access through their Git credentials.
   For a fine-grained token, choose the repository owner/repositories and the relevant
   Contents, Pull requests, Checks, and Commit statuses permissions. Set:

   ```dotenv
   GITHUB_TOKEN=your-token
   GITHUB_PR_AUTHOR=your-github-login
   GITHUB_REPO=your-org/your-repo
   ```

   `GITHUB_PR_AUTHOR` is a login, not an email; it scopes authored PRs and requested
   reviews. Both it and the token are required to enable the GitHub integration.
   The server currently targets `api.github.com`.
5. For Jira-backed work, set `JIRA_BASE_URL` to your Jira Cloud site, `JIRA_EMAIL` to
   the authenticating account, and `JIRA_API_TOKEN` to that account's
   [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).
   The account needs permission to browse the project and, for ticket voyages, assign
   issues and transition them. Helmsman uses email/token Basic authentication against
   the site's `/rest/api/3` endpoints. Set `JIRA_PROJECT` and, if needed,
   `JIRA_ASSIGNEE`. To assign ticket work to a bot, obtain its Jira `accountId` from
   the account's profile or Jira user API and set `BOT_ACCOUNT_ID`; this is not its
   email address. Match the `JIRA_STATUS_*` values to your workflow's actual status
   names. Map each tracked repository to its Jira project:

   ```dotenv
   REPO_PROJECT_MAP=your-org/your-repo=PROJECT,your-org/another-repo=OTHER
   ```

   Replace the organization-specific examples in `.env.example` with your values.
   Jira is optional for PR reviews and free-form voyages. Leave its credentials blank
   if you do not use it; Jira panels will identify their data as degraded.
6. Leave both review watchers disabled for the initial check. Run `npm run dev` and open
   the printed Vite URL (normally `http://localhost:43872`). The API listens on
   `127.0.0.1:43871` by default. Open **Config**, select a repository, and verify the
   **Local branches & worktrees** card resolves the expected checkout. Check Helm/PR
   for live data and source-error banners. Resolve credential, checkout, and agent CLI
   errors before enabling automatic work. Saving a Config row applies only that row.
7. When ready, launch a deliberate manual voyage or PR review, then follow
   [Automatic PR reviews](#automatic-pr-reviews) to enable either optional watcher.

For a production build on the same machine, run `npm run build` followed by
`npm run helmsman`, then open `http://127.0.0.1:43871` (or your `HELMSMAN_PORT`).
The built UI is served by that same server. Vite development and `npm run preview` use
port `43872` (`HELMSMAN_UI_PORT` overrides it); explicit Vite `--port` also works.
When upgrading, remove or update old `HELMSMAN_PORT=8787` overrides in your `.env`
to use the new default.
The server serves `dist/` and the API together; `npm run preview` alone is not the
Helmsman backend. To apply server source or `.env` changes during development,
stop and restart `npm run dev`; the server process is not a file watcher.

### Polling and external requests

The client loads repository metadata from the local `/api/context` endpoint.
GitHub lists refresh at most every five minutes while Helm or PR is visible. Hidden pages
pause polling; returning to a page refreshes only data that is due. Local run status
and notifications update every 30 seconds while visible. Config does not repeatedly
reload settings or scan local worktrees. The selected cmux screen refreshes every two
seconds only while its page is visible.

Helm shows the latest 10 completed voyages in the current scope. **All voyages**
opens the full history, with 25 entries per page and Previous/Next controls.
Changing galleons resets history to page one; polling keeps the current page.
Paging preserves the PR lookup draft and any open voyage logs.

The server shares GitHub list and review-history reads across tabs for five minutes,
coalesces concurrent requests, and pauses rate-limited reads until GitHub's reset.
Review preflight, PR details, diffs, and publication checks always use fresh requests.
Enabled Slack and GitHub requested-review watchers run independently of browser
visibility. Their selected trigger metadata supplies the interval; shipped packages
default to five minutes and expose `intervalMs` in plugin settings. The read-cache
periods above remain fixed in code. The selected scheduling plugin owns the separate opt-in ticket scheduler interval; see [scheduling plugins](docs/scheduling-authoring.md).

## Running agents

Click **Launch** on a backlog ticket (or `POST /api/agents/launch {ticketId,title,repo}`).
Helmsman creates a git worktree under `AGENTS_ROOT`, spawns the configured agent
(default: Codex) in it, streams the agent's events to a live log
drawer over SSE (`GET /api/agents/:id/log`), records the run in SQLite, and removes the
worktree when it finishes. `POST /api/agents/:id/stop` SIGTERMs a run. One run per repo at
a time; global concurrency is capped by `AGENT_MAX_CONCURRENCY`. The agent opens a PR and
never merges — the human review gate is real.

### New voyage (any ticket / free-form)

The **New voyage** panel launches beyond the auto-fetched backlog: in **Ticket** mode, type any
Jira key + pick a repo (Helmsman fetches the summary for the title, fail-soft); in
**Free-form** mode, give a task prompt + repo and no Jira ticket is touched (no claim, no
transition — the run row is labelled `freeform`). Both stream into the same live drawer.

### Review before PR creation

Agent-authored PR descriptions, review summaries, inline findings, and replies end
with a short attribution line, for example:
`_Helmsman · gpt-5.6-sol - med_`. Authors and reviewers use the same format,
with `med` for medium and `min` for minimal. Helmsman appends the footer when publishing PRs
and reviews; agent prompts require it on direct comments and replies too. Bylines
use the effective execution settings, including Codex defaults. Unreported provider
defaults and custom-command settings are explicitly marked rather than guessed.
The footer stays outside code and suggestion blocks, and repeated publication does
not duplicate it. Human-written reviews submitted through the UI keep their own text.

Every new coding voyage implements and commits locally, then passes an adversarial
review before Helmsman pushes the branch or opens a PR. Select the complete ordered
reviewer list with `helmsman plugins select-agent-reviewers <plugin/id,...>`. Every
selected reviewer must be available and complete its review; a failure cannot
silently reduce the gate. The selected workflow package owns prompt templates and
guarded stage sequencing. Configure `maxRounds` (1–5) and `stageTimeoutMinutes`
(5–180) on `helmsman.workflow-coding`. Defaults are three rounds and 45 minutes per
session. Agent and workflow settings are captured at admission; changes do not
affect an existing voyage. Scheduling and automatic trigger policies are independently selectable plugins.

Reviewers inspect the same pinned commit in separate detached worktrees and focus
on material logic, structure, acceptance criteria, UX, and external effects. Codex
reviewers require the installed `$review-agent` skill; each CLI delegates relevant
areas to focused leaf agents. Reviews default to low effort and use medium for
larger changes across areas. The author fixes verified findings, then **all**
reviewers review the new commit again. By default there are at most three review
rounds (two remediation rounds); setting one round permits no fix-and-review cycle.
Every reviewer must approve with no findings; incomplete
reviews, missing tools, changed revisions, and exhausted rounds block publication.

Helmsman publishes the reviewed commit itself, targeting the repository's default
branch. It selects a remote whose fetch and push URLs match the voyage repository
(prefer `origin`, otherwise require one matching remote), then verifies the pushed
SHA. The voyage log shows each stage. Failed or stopped voyages retain the author
worktree for inspection and repair; review reports and PR metadata live under the
run directory in a `.pre-pr` artifact folder. These worktrees survive restart sweeps
and can be removed from the local branches/worktrees page when no longer needed.
The workflow runs in the existing durable run host and survives server restarts.

This gate applies to new coding voyages, not existing-PR feedback reruns. The generic
`command` adapter cannot launch a new coding voyage because it cannot provide this
review contract. `AGENT_MAX_ATTEMPTS` does not multiply the captured workflow `maxRounds`.
Each author, fix, or reviewer session has a 45-minute timeout by default. The existing post-PR review
and Copilot request still run after successful publication.

### Recent voyages

After a successful coding voyage opens a PR, Helmsman requests Copilot and queues
its own independent adversarial review as a separate voyage. The durable queue
waits for repository capacity, survives restarts, and reuses a running or successful
review of the same revision. It runs on completion and retries pending work on the
existing five-minute cadence, with no external reads when idle or busy. This does
not require either Slack or requested-review polling to be enabled. Closed, merged,
or draft PRs are blocked with a notification; transient lookup failures stay queued.
Review failures are visible and do not trigger an automatic retry loop.

The review challenges the author's claims and checks realistic failure paths while
retaining the material-defect threshold, inline findings, complexity-based model
selection, and COMMENT-only publication. Persistent notifications link the review
and original coding voyage. Review voyages and feedback reruns do not recursively
queue more reviews. Existing historical PRs are not backfilled.

The PR-creation agent must not request code owners, teams, or human reviewers,
including through review mentions. GitHub's automatic CODEOWNERS rules can still
add reviewers.

Opening a voyage shows a bounded preview of its latest 300 log entries. Updates
are batched to keep the browser responsive; long entries are shortened in the
preview. **Download full log** retrieves all persisted output, including earlier
entries and full-length lines. For an active run, the download is a snapshot at
the time it is requested. Completed voyages close their log streams.

Output uses the selected theme's background, text, and syntax colors. Commands,
JSON, code snippets, and diffs receive lightweight highlighting; errors keep a
distinct colored edge. The log has no grid or text glow. Highlighting changes
presentation only; full log downloads retain the original output.

The **Recent voyages** panel lists completed/failed/stopped runs. Click any to re-open its
stored log (replayed from SQLite), final status, cost, and PR link — the same drawer used
for live runs.

Voyage rows and log tabs show a stable short ID derived from the persisted run ID.
UUIDs use their first 12 hexadecimal characters; automatic reviews retain their
`slack-`, `github-`, or `created-` prefix followed by 12 hexadecimal characters. Hover the ID
to see the full value. Links and log downloads continue to use the full run ID.

### PR controls

PR panes show the title, author, overall state, checks, and your submitted review
status. Approval progress shows the two required distinct reviewers (for example,
`1/2 approvals · 1 needed`). Dismissed approvals do not count, and outstanding
change requests remain visible even when two approvals have been received. This
counts reviews; GitHub still enforces other merge requirements. Ownership and
personal review status use `GITHUB_PR_AUTHOR`. Relaunch with
feedback is available only for your own PRs in a configured local repository;
crew code review remains available for other authors' PRs. A later comment does
not clear an existing approval or change request.

The **PR** tab lists **Review requests** and **My recent pull requests** (including your open PRs) above the review controls. Open authored rows show current approval and change-request counts, plus GitHub discussion-comment counts. Unavailable review history stays unknown rather than zero. Select a row to load its details and diff. The **Helm** page keeps **Open PRs** for the selected repository, including every author; select a repository to populate it. Lists report loading, unavailable, empty, and partial-result states independently.

**Recent PR voyages** shows the latest 10 PR-related runs in the selected repository
from the local run history, with status and saved review results. Select a voyage to
open its output, or **All voyages** for the full list. It uses the existing local
refresh and preserves any unsent review while updating.

A run with a PR shows a **PR panel** in its drawer (state, CI checks, review decision,
comments, link); a **Review a PR** panel takes any PR (paste a URL or `owner/repo#number`)
so you can act on PRs that aren't from a run. From the panel you can **Approve /
Request changes / Comment** through durable public PR commands and — when the PR's
repo is checked out under `AGENTS_ROOT` — **Relaunch with feedback**: the agent checks out the
existing PR branch, addresses the feedback, and pushes the **same** branch so the PR updates
(no new PR, no Jira claim). Reads and new review/rerun preparation use the selected
PR provider, retaining its connection, settings, artifact and exact head. A missing
or changed selection blocks admission. Publication remains a guarded server-side
operation; credentials never reach the browser. **There is no Merge button** —
merge stays a deliberate action on GitHub, and the agent never merges.

### Direct links

Each tab has a page URL: `/helm`, `/triage`, `/todos`, `/terminal`, `/bugs`, `/prs`, `/config`, and
`/runs`. `/` opens Helm, and `/pr` is an alias for `/prs`. Links can include a pane
and the context needed to open a PR, inspect a voyage, or prepare a new voyage.

| Destination | Example URL |
| --- | --- |
| Repository's open PRs on Helm | `/helm?repo=gdcorp-partners/airo-app-builder&pane=repoprs` |
| Requested reviews | `/prs?pane=review-requests` |
| PR details and diff | `/prs?repo=gdcorp-partners/airo-app-builder&pr=10280&pane=diff` |
| Prepare a crew PR review | `/runs?repo=gdcorp-partners/airo-app-builder&pr=10280&mode=review&pane=newrun` |
| Prepare a PR relaunch | `/runs?repo=gdcorp-partners/airo-app-builder&pr=10280&mode=rerun&pane=newrun` |
| Existing voyage's log | `/runs?run=99723f3e-ff89-433a-8621-f30a48b96fd4` |
| Prepare a ticket voyage | `/helm?repo=gdcorp-partners/airo-app-builder&ticket=AIRO-123&pane=newrun` |
| Local branches and worktrees | `/local-git?repo=gdcorp-partners/airo-app-builder` |
| Selected terminal | `/terminal?surface=surface:15&pane=screen` |

Voyage links only prefill the form; opening a link never launches an agent or submits
a review. A PR number requires its `repo=owner/name`. On Helm, `repo` selects a tracked
repository; PR and voyage links can name repositories outside the tracked list.
Malformed parameters and panes belonging to another tab are ignored.

The header, page tabs, notification center, and footer form a persistent shell across
all views. Only the page content scrolls and changes on navigation. Fleet counts
stay scoped to the selected repository; unavailable queue/review counts show an
em dash until a Jira snapshot is loaded, without fetching solely for the header.

Available panes are `newrun`, `backlog`, `underway`, `running`, `recent`, `repoprs`, `shipped`, and
`activity` on Helm; `backlog`, `todo`, and `mine` on Triage; `tabs` and `screen` on Terminal;
`review-requests`, `authored`, `lookup`, and `diff` on PRs; and `recent`, `newrun`, and
`tasks` on Voyages. Terminal selects an authored composition using the public terminal service; native I/O uses the selected provider, and existing `/cmux` links select the same page. Bugs and Config link directly to their page. See [Terminal authoring](docs/terminal-authoring.md).

For native cmux sidebar Codex cost estimates, see [the local integration](docs/cmux-codex-costs.md).
It uses recorded session tokens and labeled API estimates, independently of the Helmsman server.

### Triage filters

The [Triage package](src/plugins/triage/README.md) at `/triage` filters through the selected provider before pagination and uses independent bounded cursors under one observation window. Its shared filter bar combines P0–P4 priorities with Any time or the last 30, 7 or 1 days. Page sizes are 5, 10, 25, 50 or 100 (default 10); source and filter changes reset pagination. It preserves per-panel source/filter settings, labels partial results, and links related voyages only when core verifies their canonical task and galleon. The [Bugs package](src/plugins/bugs/README.md) keeps approximate counts, unavailable metrics, actual due dates and capped resolution samples distinct.

The first Triage composition imports prior browser filters, page size and collapsed groups while archiving the original strings. Existing layouts, including intentionally empty layouts, remain unchanged. Legacy `pane=backlog|todo|mine` links target existing Triage panels without creating removed panels.

### Config editor

The Config tab edits core runtime values and links to independently replaceable Jira and GitHub settings. The Jira connection page provides revision-checked, write-only token updates; existing source settings own live Jira configuration. See [integration settings authoring](docs/integration-settings-authoring.md). See [Configuration](#configuration) for every field, its default, storage,
and restart behavior. UI customization remains on Config; local Git controls open the replaceable Local Git page.

### Local todos

Todos and Jira coexist. In **Config → Source settings**, enable each source independently,
change its label and allowed galleons, and edit advanced non-secret settings. The
panel follows the header galleon unless you select an explicit panel override; the
override never changes the header. Todos, Triage and Bugs retain their routes when a
source becomes unavailable, and unsaved form changes remain available.

Disabling a source stops new work. Admitted voyages keep their recorded provider,
configuration and connection, with retained artifacts available for settlement.
The Helm backlog carries each task's canonical source identity and display URL.

Each todo has a title, repository (`owner/name`), priority P0–P4, description,
acceptance criteria, state, timestamps, and a link to its retained latest voyage when that voyage still belongs to the selected galleon. Repositories
must already be cloned under `AGENTS_ROOT` as described in setup. Save title-only
drafts, then add a description to make them launchable. Use acceptance criteria for
tests, edge cases, and constraints the crew must satisfy. The list supports search,
state filters, and repository scope.

Launching atomically claims a To do item and sends its saved details to the agent.
In progress items cannot be edited or deleted. Successful voyages move to In review;
failed or stopped voyages move to Blocked. Review the output before marking Done,
or return the todo to To do to retry. No completion state automatically merges a PR.
Todo state and run links survive server restarts; interrupted claims are reconciled
against persisted voyages. Todos are stored in the same SQLite database as voyages.

### Clarification questions

New voyages and attempts retain dedicated question/answer channels with their execution snapshots. A retry or pre-PR continuation receives a new channel; recovery reuses the recorded one. Required unanswered questions remain publication blockers across attempts, including legacy questions whose producing attempt cannot be proven. Those legacy questions stay visible but reject new answers, including through the compatibility API. See [clarification recovery](docs/recovery.md#clarification-channels-and-unresolved-questions).

An accepted answer is stored durably before the core runtime publishes it to the worker's channel. Acceptance does not prove that the worker consumed it. Authored panels use durable request receipts and revision-checked answer commands. Legacy HTTP ingestion, ID-only answers and unversioned contact writes return 410 even when the replacement service is unavailable; historical reads remain for recovery. See [the contracts](docs/clarification-authoring.md) and [retained recovery](docs/plugin-legacy-retirement.md).

### Auto-claim

Choose automatic sources per galleon in **Config → Source settings → Automatic starts**.
Initial conversion selects only the previously active source; enabling another
source does not silently add it to scheduling. The saved source selection survives
restart. The shipped scheduling plugin rotates among selected available sources and honors each provider's
ready-work ordering. Alternate [scheduling plugins](docs/scheduling-authoring.md) can choose a different policy; all use the same claim/concurrency gates as manual launch.
Todos without a description remain editable drafts and are excluded from ready work.

The Todos tab's automatic-start control enables the galleon's scheduler through
versioned source-administration commands. At most one item is admitted per heartbeat
while the galleon is idle. Enablement remains in memory and resets on restart; it is
separate from the persisted selection of automatic sources. The legacy
`POST /api/repos/:repo/auto-claim` endpoint also requires a JSON boolean `enabled`;
malformed JSON or invalid values return 400 without changing enablement.

### Task-source plugins and recovery

An installed compatible provider can replace a verified logical source through
**Replace source provider**: explicitly choose a candidate, enter an operator and
reason, validate, then adopt. The host rechecks source/configuration revisions and
preserves existing task identity, stored data, enablement, and earlier voyage bindings.
An operator-seeded Jira source remains usable through its original connection but
cannot claim verified identity for cross-provider adoption.

A completed worker can still have an unsettled source claim. **Recovery → Source
claims** displays the original worker outcome, source/provider, settlement state and
retained dependency pins. Retry source settlement uses retained execution and request
evidence; it does not relaunch the worker or manufacture an outcome. Safe start
shows the same diagnostics read-only.

See [task-source authoring](docs/task-source-authoring.md), [recovery](docs/recovery.md),
[plugin packages](docs/plugin-packages.md), [composable pages and panels](docs/panel-authoring.md), and the [phase completion ledger](docs/plugin-implementation-progress.md).

### Agent providers

Agent selection pins one immutable writer and an ordered list of immutable reviewers,
including each provider package, artifact hash, compatible non-secret settings and
metadata. Select them with `helmsman plugins select-agent <plugin/id>` and
`helmsman plugins select-agent-reviewers <plugin/id,...>`. The shipped packages are
`helmsman.agent-codex/codex`, `helmsman.agent-claude/claude-code`, and
`helmsman.agent-command/command`. Configure package settings with `helmsman plugins
configure <plugin-id> '<json>'` before selection.

Provider metadata declares defaults, review tuning, skills/delegation, Docker
compatibility and whether costs are delta or cumulative. Codex defaults to
`gpt-6-astra`/medium and declares the review-agent skill; Claude Code uses provider
defaults and native subagents; command uses its namespaced `commandTemplate` setting.
The command template supports `{ticket}`, `{repo}` and `{title}`, is argv-only, and
an empty template never falls back to Codex. Legacy `AGENT_ADAPTER` and `AGENT_CMD`
values remain readable for legacy recovery. The adapter seeds the initial selection
once; command text is never copied automatically because it may contain credentials.
Configure a nonsecret `commandTemplate` explicitly; Config cannot edit retired keys.

Managed model traffic for local and Docker stages uses the run-scoped Helmsman gateway and GoCaaS. Host credentials are never passed to stages, and unsupported custom transports are blocked at admission. See [model routing](docs/model-routing.md) for GoCaaS settings and authentication.

The retained workflow renders authored prompts from a bounded public task projection.
Core chooses effective model/effort, owns admission, guarded execution and recovery,
and validates every provider command and event. A provider-reported result failure makes
the run fail even when its process exits zero; an unknown result does not. Providers
do not emit core completion events.

### Workflow providers

Workflow extraction is accepted and pushed through `eb8ad1a`. `helmsman/workflow@1` separates
prompt rendering and pure next-step policy from core stage, revision and publication
guards. Select each task mode independently:

```sh
helmsman plugins select-workflow coding helmsman.workflow-coding/coding
helmsman plugins select-workflow review helmsman.workflow-review/review
helmsman plugins select-workflow branch helmsman.workflow-coding/branch
helmsman plugins configure helmsman.workflow-coding '{"maxRounds":3,"stageTimeoutMinutes":45}'
```

`select-workflow <mode> default` (or `null`) restores that mode's shipped default.
An explicit unavailable provider blocks new work. New admissions retain the original
workflow artifact, metadata, settings, prompts/skills identity and checkpoint state;
restart or a changed default never substitutes a different workflow. Completed
checkpoint stages are not repeated. `coding@1` and `review@1` remain aliases for new
admissions; legacy voyages keep their original compatibility workflow.

Old `PRE_PR_*` values are bootstrap inputs only. The old reviewer count initializes
an explicit ordered agent list once; rounds and timeout initialize coding package
settings once. Explicit lists, settings and subsequent resets are preserved. See
[workflow authoring](docs/workflow-authoring.md).

### Native terminals and browser hosts

Use `helmsman plugins select-native-terminal <plugin/id>` for terminal I/O and
`helmsman plugins select-browser-host <plugin/id>` for communication browsing.
The shipped providers are `helmsman.terminal-cmux/cmux`,
`helmsman.native-firefox/firefox`, and `helmsman.terminal-wezterm/wezterm`; cmux and Firefox support browser primitives.
Selections are independent, so WezTerm terminals can coexist with cmux- or Firefox-backed Slack.
Configure `binary` and `socketPath` on cmux/WezTerm, or the exact credential-free loopback `bidiEndpoint` returned by an operator-created disposable Firefox WebDriver session. `TERM_BRIDGE`,
`CMUX_SOCKET_PATH`, `WEZTERM_BIN` and `WEZTERM_UNIX_SOCKET` seed initial settings once.
Existing terminal receipts never resend input after provider changes or disablement.
See [native terminal authoring](docs/native-terminal-authoring.md).

### Execution hosts

Select a host with `helmsman plugins select-execution-host <plugin/id>`. The shipped
providers are `helmsman.host-local/detached`, `helmsman.host-local/cmux`,
`helmsman.host-local/wezterm` and `helmsman.host-docker/docker`. Configure namespaced
settings and restart after selection. Docker's `image` setting resolves to a fixed
image digest for each run. Local execution-host settings govern launched sessions;
the separate native terminal packages govern interactive terminal I/O.

Every admitted run retains its provider artifact, settings and run configuration.
Launch, discovery, stop, recovery and isolated child stages use that retained
provider after settings/default changes or disablement. Disablement blocks new
admission. Unknown ownership blocks recovery without launching a replacement.
Core retains durable receipts, concurrency, workspace and publication safeguards.
See [execution host authoring](docs/execution-host-authoring.md).

### Caps

`AGENT_MAX_ATTEMPTS` bounds retries for existing-PR voyages; new coding voyages use
one gated workflow with the bounded review loop above. `AGENT_MAX_COST_USD` (opt-in)
stops work once reported cost reaches the cap. Pre-PR voyages aggregate reported
cost across author and reviewer sessions; Codex sessions currently provide no cost
data, so the cap cannot bound their spend. Both, and the live attempt/cost of
each run, show on the running-agent rows (`×attempt/max`, `$cost/$cap`).

### Resilience

On startup Helmsman reattaches to surviving run hosts and marks interrupted runs
failed when their host is gone. It sweeps orphaned agent worktrees under each repo's
`.worktrees/`, except failed or stopped pre-PR voyages retained for recovery. These
checks are fail-soft: a failure is logged and never blocks the server from listening.

## Configuration

The tables describe **runtime defaults when unset**, which can differ from the
example values in `.env.example`. Use positive integers for intervals, attempt limits,
and concurrency; use a positive number for an optional cost cap. Blank optional
values mean unset unless a row says otherwise.

At startup, Node loads `.env` without replacing variables already exported by the
parent shell. SQLite overrides saved through Config then take precedence over both.
Editing `.env` does not erase a saved override, including a saved empty string, and
there is currently no UI action to remove an override. Use Config to update an
already-overridden setting. Overrides, runs, watcher checkpoints, and notifications
persist in `HELMSMAN_DB`; a browser reload does not reset them.

**Live** below means editable through the owning settings service and used by
subsequent requests or launches. Jira source fields belong to Source settings;
GitHub defaults/author belong to GitHub settings; Slack connection fields belong
to Communication settings. Generic Config rejects migrated integration writes.
Existing runs keep their launch configuration.
**Restart** means configure in `.env` or the parent environment and restart the
server; restart Vite too when changing `HELMSMAN_PORT`. Even Live keys changed in
`.env` require a restart to be loaded. The auto-claim interval is UI-editable, but its
timer length changes only after restart. Legacy watcher flags seed trigger settings
once; they are not live controls. Slack and GitHub settings show read-only watcher
status and direct configuration to the selected trigger plugin. Follow the plugin
CLI restart instruction after changing trigger settings.

### Jira

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `JIRA_ENABLED` | `true` | Initial Jira source enablement during conversion. Manage an existing source independently in Config → Source settings; Todos remains available. | Initial conversion |
| `JIRA_BASE_URL` | Empty | Jira Cloud site URL, e.g. `https://your-team.atlassian.net`, without an issue/API path. Required with email and token to enable Jira. | Restart |
| `JIRA_EMAIL` | Empty | Email of the account that owns the API token. Never returned to the UI. | Restart |
| `JIRA_API_TOKEN` | Empty | Atlassian API token for that account; see setup for read/write permissions. The Jira connection page accepts a revision-checked replacement without returning the token and stores it in SQLite. Empty token updates are rejected. | Live, write-only |
| `JIRA_PROJECT` | `AIROBUILD` | Default Jira project key. Selecting a mapped repository substitutes its project from `REPO_PROJECT_MAP`. | Live |
| `JIRA_ASSIGNEE` | `currentUser()` | Assignee for the queue, active-work, and My issues queries. Use a Jira account ID or JQL function such as `currentUser()`. | Live |
| `JIRA_JQL` | Empty | Full override of the backlog queue query, e.g. `project = PROJECT AND status = Backlog ORDER BY priority`. Also affects auto-claim; a custom query must apply its own project/assignee scope. Other panels retain their own queries. | Live |
| `BOT_ACCOUNT_ID` | Empty | Jira account ID to assign ticket voyages to. Without it, the initial bot-assignment/claim step is skipped. Free-form and PR tasks do not claim Jira tickets. | Restart |
| `JIRA_STATUS_IN_PROGRESS` | `In Progress` | Destination status when claiming a ticket; must be reachable through an available Jira transition. | Restart |
| `JIRA_STATUS_IN_REVIEW` | `In Review` | Destination status after successful ticket work reaches its review gate. | Restart |
| `JIRA_STATUS_BACKLOG` | `Backlog` | Actual Jira status for Triage's unassigned Backlog column. | Restart |
| `JIRA_STATUS_TODO` | `To Do` | Actual Jira status for Triage's unassigned To Do column; use the status name rather than a board-column label. | Restart |

The default queue JQL still uses literal `Backlog`; use `JIRA_JQL` for a different
queue status. The active-work query still uses `In Progress`, `In Review`, and `Done`.
Changing `JIRA_STATUS_*` does not rewrite those dashboard queries.

### GitHub and repository scope

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Empty | GitHub token used by the server for API reads and review publication. See setup for repository access and permissions. Never displayed or editable in Config. | Restart |
| `GITHUB_PR_AUTHOR` | Empty | GitHub login used for authored PRs and review requests. Both this and `GITHUB_TOKEN` must be nonempty for GitHub to be configured. | Live |
| `GITHUB_REPO` | Empty | Optional `owner/name` repository added to tracked repositories and automatic-review eligibility; also supplies the default repository label. With no repo, the label falls back to `@<author>`. | Live |
| `REPO_PROJECT_MAP` | Empty | Comma-separated `owner/name=PROJECT` pairs. Populates the repo selector, maps dashboard/auto-claim Jira scope, and permits automatic reviews for those repos. | Live |
| `GITHUB_REVIEW_WATCH_ENABLED` | `false` | Seeds GitHub review trigger enablement once. Subsequently configure the selected `github-review` trigger. Existing pending requests can launch when enabled. | Initial conversion |

### Slack browser reader

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `SLACK_WATCH_ENABLED` | `false` | Seeds Slack review trigger enablement once. Subsequently configure the selected `slack-review` trigger. The communication source and signed-in browser must also be available. | Initial conversion |
| `SLACK_CLIENT_ID` | Empty | First identifier after `/client/` in the open Slack URL. This is the browser client/workspace identifier, not an OAuth app client ID. | Live |
| `SLACK_CHANNEL_ID` | Empty | Channel identifier beginning with `C`, from the Slack channel URL. Must match the channel being watched. | Live |
| `SLACK_CHANNEL_NAME` | Empty | Channel name without `#`, using lowercase letters, digits, `_`, or `-`; used to scope Slack search. | Live |
| `SLACK_BROWSER_SURFACE` | Empty | Optional cmux browser reference, e.g. `surface:24` or its UUID. Leave empty to discover the matching signed-in Slack tab. Useful when multiple tabs match. | Live |

Slack text fields are blank by default and the watcher is off. See
[Automatic PR reviews](#automatic-pr-reviews) for first-time browser setup and triggers.

### Requesting reviews in Slack

Owned open PRs link to the authored Communication page with that PR selected. Its
review-request panel displays the exact provider artifact, workspace, channel, group,
and connection before Send. The caller-scoped browser journal reserves the complete
request before transport. Lost responses retain that identity for receipt lookup or
exact Retry; missing journal entries send nothing.

Configure the destination in **Communication settings**. Defaults are `airo-editing`
and `airo-editing-squad`. Use a channel name or ID and the user group's handle. Saving
uses the displayed settings revision and never sends.
Requests use the signed-in Slack browser, sharing `SLACK_CLIENT_ID` and
`SLACK_BROWSER_SURFACE` with the Slack reader. Browser reading and sending are
serialized so they do not interfere. Existing message drafts are preserved.
Sending works independently of whether automatic Slack watching is enabled.

| Value | Default | Purpose |
| --- | --- | --- |
| `SLACK_REVIEW_CHANNEL` | `airo-editing` | Destination channel name or ID; live-editable. |
| `SLACK_REVIEW_MENTION` | `airo-editing-squad` | User group handle; selected as an actual Slack mention. |

The server verifies that the PR is open and authored by the configured GitHub user.
Each request pins its displayed destination and provider artifact. Persisted receipts
prevent repeated delivery for the same request ID, and a short cooldown applies across
callers. An uncertain send is never automatically repeated. Finding the same or another
PR URL in Slack does not prove this request; use its exact retained receipt or Core
Recovery. See [Communication authoring](docs/communication-authoring.md).

### Agent execution and server storage

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `AGENT_MAX_ATTEMPTS` | `1` | Total attempts for existing-PR voyages, including the initial attempt; `1` means no retry. New coding voyages use one workflow, with review rounds controlled by its captured `maxRounds` setting. | Live |
| `AGENT_MAX_COST_USD` | Empty (no cap) | Cost limit in USD across attempts, enforced from validated provider cost events. | Live |
| `PRE_PR_REVIEWER_COUNT` | `2` | Legacy count seeds the explicit ordered agent reviewer list once, preserving an existing explicit list. Subsequently use `plugins select-agent-reviewers ID[,ID...]`; `default` resets to shipped defaults without reimporting the old count. | Bootstrap only |
| `PRE_PR_MAX_ROUNDS` | `3` | One-time seed for `helmsman.workflow-coding` setting `maxRounds` (1–5). Afterwards configure the package; explicit settings and resets are preserved. | Bootstrap only |
| `PRE_PR_STAGE_TIMEOUT_MINUTES` | `45` | One-time seed for `helmsman.workflow-coding` setting `stageTimeoutMinutes` (5–180). Afterwards configure the package; explicit settings and resets are preserved. | Bootstrap only |
| `AGENT_MAX_CONCURRENCY` | `3` | Maximum simultaneous runs across repositories. The separate one-run-per-repository limit still applies. | Restart |
| `AUTO_CLAIM_INTERVAL_MS` | `60000` | One-time migration seed for the shipped scheduling plugin’s `intervalMs`. Does not enable automatic starts or control PR watchers. | Bootstrap only; then configure plugin settings |
| `AGENTS_ROOT` | Server working directory | Parent directory of target repo checkouts, e.g. `/absolute/path/to/agent-repos`; not the path to a single checkout. | Restart |
| `RUNS_DIR` | `<AGENTS_ROOT>/.helmsman-runs` | Directory for detached-run specifications, logs, and exit records. Created on startup; use a writable absolute path. | Restart |
| `RUN_HOST` | Detached process | One-time execution-host selection seed: `detached`, `cmux`, `wezterm` or `docker`. Unknown names fail; unavailable hosts never fall back. After migration use `plugins select-execution-host`. | Bootstrap only; then plugin selection and restart |
| `HELMSMAN_DB` | `<server working directory>/.helmsman.sqlite` | SQLite file for runs, config overrides, watcher state, and notifications. Use a writable path and retain it across restarts. A saved Jira token is stored here, so treat this file as sensitive. | Restart |
| `HELMSMAN_PORT` | `43871` | Local API/static-server port, bound to `127.0.0.1`; the Vite API proxy uses the same value. | Restart server and Vite |
| `HELMSMAN_UI_PORT` | `43872` | Vite development and preview UI port; an occupied port stops startup instead of selecting another port. | Restart Vite |

### Browser preferences

Config's **UI customization → Theme** selector applies immediately and persists in
that browser's local storage (default: Amber). The selected repository, dashboard
panel layout/stacking, and collapsed panels also persist locally. These preferences
have no `.env` keys, do not change server behavior, and are not shared with another
browser. Per-voyage model/effort choices belong to the launch form; there are no
global model/effort environment variables in the app's config parser.

Dark presets include Quarterdeck (sea blue/wood brown/brass), Abyss (navy/cyan), Forest (green/mint), Ember (brown/coral),
Aubergine (wine/rose), Graphite (near-black/white), and Phosphor (black/lime).
Themes color the full interface, including panels, text, and scrollbars.
The selected theme's palette and sample status chips appear below the selector,
updating immediately so you can compare surface, text, and status colors.
Page panels use the full content width or two equal columns, stacking on smaller screens.

Helm's **Mine · underway** panel reads the selected source's optional underway view.
Jira exposes the configured assignee's unfinished tickets independently of queue JQL;
local Todos expose in-progress and in-review tasks. Select a concrete repository and
a currently ready task to launch. These tasks are separate from active agent voyages
in **Active crew**. Missing or unavailable provider views remain explicit; the panel
does not substitute ordinary queue results or sample tickets.

> **Security:** Codex uses `--dangerously-bypass-approvals-and-sandbox`; Claude Code uses
> `--dangerously-skip-permissions`. Coding agents can edit,
> commit, and open a PR with full, unattended tool access on the host — a per-run git
> worktree is a working directory, not a sandbox (it shares the repo's git object store and
> the agent has the same host, shell, and filesystem access as the Helmsman process).
> The default detached host inherits `GITHUB_TOKEN` and removes `JIRA_API_TOKEN` and
> `JIRA_EMAIL` from the child environment; cmux workspaces use their own terminal environment.
> Helmsman makes Jira writes itself. Only point `AGENTS_ROOT` at repos,
> and only launch tickets, you're willing to let an autonomous agent modify on this machine.

### Degraded mode

With `.env` present but credentials missing or invalid, Helmsman falls back per-source to
`src/data/mock.ts` for whichever of Jira/GitHub it couldn't reach, and the response's
`degraded` array names which sources are mocked (e.g. `["jira","github"]` with neither integration configured).
The dashboard renders a banner naming the degraded sources so it never shows fake data as
real.

The replaceable Local Git page, linked from Config, reads the selected repository’s
configured checkout under `AGENTS_ROOT`. It shows the checkout path, local branches
and upstreams, and registered worktrees. Refresh stays local. Fetch remote status explicitly
fetches and prunes remote-tracking branches so deleted upstreams can be identified;
it does not prune local branches or tags.

Delete branch and Delete worktree require confirmation of the named target. Unmerged
branch deletion requires an additional explicit checkbox. Current/default branches,
primary/locked/active worktrees, changed commits, and mismatched checkouts are
protected. Worktrees containing uncommitted, untracked, or ignored files cannot be
removed through this control. No cleanup runs automatically.

**Clean up branches** previews local branches with no configured upstream or a deleted
upstream. By default, only branches already merged into the current HEAD are eligible.
Select **Include unmerged branches** to also remove branches with unmerged commits;
the preview warns before this destructive option is confirmed. The preview
lists each candidate and explains protected skips; confirmation deletes
the exact reviewed names and commits atomically. Any changed branch or HEAD requires a
new preview. Use **Fetch remote status** first to refresh deleted-upstream information.
Current, default, and checked-out branches remain protected in either mode.

Single and bulk branch deletion hold Git's HEAD locks for existing worktrees while
rechecking checkout ownership and committing the expected-commit ref transaction.
This also protects detached worktrees that switch to a target branch at the same
commit. A failed guard or a shared ten-second transaction deadline cancels the
operation and releases its locks. The implementation uses ordinary `update-ref`
transactions and does not require the newer `symref-verify` command.

Git does not provide a transaction covering registration of new worktrees. External
worktrees created after the final ownership check, concurrent pruning/replacement of
worktree metadata, and tools that bypass Git's locks remain outside this guarantee.
Avoid creating or pruning worktrees in another tool while cleanup runs. Regression
tests cover checkout races, new worktrees detected before the final check, changed
refs, detached and missing worktrees, failed guards, deadlines, and lock release.

`GET /api/usage/external` exposes actual server HTTP request counts by service,
including lifetime and rolling five-minute totals, errors, and rate-limit responses.
Counters exclude cache hits and local requests, reset on server restart, and retain
no credentials or request bodies. Slack browser traffic, Git subprocesses, and
review-agent/model traffic are separate and are not counted by this endpoint.

## Automatic PR reviews

Helmsman can discover PRs through two independently selected trigger plugins, each defaulting to a five-minute interval:

- Slack: full GitHub PR URLs posted in one configured channel, including thread replies. No mention or review wording is required. Each source message/PR pair runs once; posting the URL again is a new trigger. History before activation is ignored.
- GitHub: pending requests for `GITHUB_PR_AUTHOR`, once per repository/PR/head SHA. Existing pending requests are eligible when enabled; a new revision can trigger another review. A running or successful review of that revision can satisfy the request.

Both sources persist their queues and notifications in the Helmsman SQLite database. The header notification bell shows source health, queued/started/failed/blocked reviews, links to the source and run, and the selected model/effort. Marking a notification read persists across reloads and restarts. Existing concurrency limits apply; repositories must be configured in `GITHUB_REPO` or `REPO_PROJECT_MAP`. Requests for unconfigured repositories remain visible as blocked.

Incoming automatic Slack reviews skip PRs authored by the account authenticated by the selected GitHub connection. Missing identity remains queued. This does not change the configured-author policy for manual outgoing review requests.

Both watchers start disabled. For Slack, select a browser-capable native provider. With the default cmux provider, install/open cmux with its `cmux` command
available to Helmsman, and open Slack in a **cmux browser tab**. Sign in and navigate
to the one channel you want to watch. Its URL has this shape:

```text
https://app.slack.com/client/<client-id>/<channel-id>
```

Copy those two identifiers into `SLACK_CLIENT_ID` and `SLACK_CHANNEL_ID`, and set
`SLACK_CHANNEL_NAME` to the channel name without `#`. Fill and save those fields
before enabling the watcher. The cmux provider discovers only its own browser tabs. To use a dedicated Firefox automation session, follow the [Firefox provider setup](src/plugins/native-firefox/README.md) and select `helmsman.native-firefox/firefox`. Ordinary tabs outside the selected provider are not discoverable.
Leave `SLACK_BROWSER_SURFACE` empty unless you need to pin a particular tab; use
`cmux tree --json` to find that browser's `surface_ref` when needed.

The initial `.env` values are deliberately empty/disabled:

```dotenv
SLACK_WATCH_ENABLED=false
SLACK_CLIENT_ID=
SLACK_CHANNEL_ID=
SLACK_CHANNEL_NAME=
SLACK_BROWSER_SURFACE=
GITHUB_REVIEW_WATCH_ENABLED=false
```

After checking the channel values, GitHub configuration and local checkout, configure
the selected trigger package and follow the CLI restart instruction. For the shipped
selections:

```sh
helmsman plugins configure helmsman.trigger-slack-review '{"enabled":true}'
helmsman plugins configure helmsman.trigger-github-review '{"enabled":true}'
```

Enable only the sources you want. Slack and GitHub settings display watcher status;
the old environment flags initialize settings once and do not override later changes.
Check the notification bell's source health. Only new Slack history after activation
is eligible; a full URL such as `https://github.com/your-org/your-repo/pull/123` is a
trigger. GitHub-only discovery needs no Slack fields or browser and can immediately
launch reviews for existing pending requests. Automatic reviews publish to GitHub.

Use `helmsman plugins select-trigger <role> <plugin/id>` to replace a policy, with
roles `campaign`, `slack-review`, `github-review` and `github-webhook`. `default`
restores that role's shipped selection; `disabled` or `null` disables it. Explicit
unavailable selections do not fall back. See [trigger authoring](docs/trigger-authoring.md)
and [webhook setup](docs/webhooks.md) for route settings and core credential rotation.
Trigger extraction is reviewed and pushed through `12a62c9`.

Keep one signed-in Slack browser tab open in the selected provider for the configured channel/client. The reader discovers that tab on each scan; set `SLACK_BROWSER_SURFACE` only when multiple matching tabs exist. The cmux provider briefly selects its Slack browser tab and restores the previous tab and focus unless the user changes them during the scan. Firefox uses background context selection without foregrounding its tab. It uses browser UI searches and rendered message anchors, without Slack MCP or extracted session tokens. Browser closure, sign-out, or incomplete search results appear in source health. Catch-up resumes from the last successful scan with an overlapping search window. Five minutes is a target while the machine, browser, and server are running; Slack search indexing may add delay. Reading Slack views can affect unread state.

Review model selection defaults to these tiers for Codex:

| Complexity | Model | Effort | Signals |
| --- | --- | --- | --- |
| Low | `gpt-5.6-terra` | low | Default, including large changes confined to one area or unavailable scope |
| Medium | `gpt-5.6-sol` | medium | More than 5 files or 300 changed lines, spanning multiple areas |
| High | `gpt-6-astra` | high | Explicit selection for serious architecture changes; never selected automatically |

Automatic routing is limited to low and medium. File size, sensitive paths, and unavailable diffs do not trigger high effort. Claude Code uses Sonnet for low/medium and Opus for high; the command adapter keeps its own model behavior. Explicit selections in PR controls override automatic tuning. The assessed revision, model, effort, complexity, and reason are saved with the run; review checkouts are pinned to that revision.

Reviewers reserve request-changes recommendations for demonstrated material logic,
structural/integration defects, or missed explicit acceptance criteria. They omit
standalone test/doc/style suggestions and speculative hardening. A lead delegates
applicable logic, acceptance/tests, UX, and external-effects scopes, then verifies
and deduplicates findings. Codex review runs enable multi-agent support and require
an installed `$review-agent` skill for each read-only leaf reviewer. The lead alone
writes the output files. Missing required skills or delegation tools produce a
COMMENT limitation. Low effort remains the default for scoped workers; high effort
is reserved for serious architecture changes. See the [five-review calibration
audit](docs/reviewer-calibration-2026-09-17.md) for examples and rationale.

Reviewers target a customer-ready implementation within the ticket scope, not perfection. Scope expansion needs an explicit acceptance criterion or a concrete consequential regression, plus an explanation of why a smaller fix is insufficient. Credible rare edge cases belong in brief **Non-blocking** summary notes; they do not prevent approval or become fix-stage obligations. Blocking a rare case requires concrete evidence of a serious consequence or an explicit material acceptance failure. Only blocking defects belong in findings; a completed staged review with advisory notes uses `APPROVE` and `findings: []`.

Reviews prefer inline findings on the relevant diff lines, with concrete fixes when supported by the code. Exact replacements use GitHub suggestion blocks; broader changes use code examples. The agent writes a concise summary to `.agent-review.md` and a JSON array of inline findings to `.agent-review-comments.json`. Helmsman validates the anchors against the reviewed revision and submits the summary and inline findings together as one COMMENT review. Findings that cannot be safely anchored remain in the summary. If the PR head changed, inline publication fails rather than attaching stale findings to new code. Existing summary-only output remains supported. Reviews do not push code or approve/merge PRs.

Model roles and effort guidance: [official OpenAI model documentation](https://developers.openai.com/codex/models/). Model availability depends on the account/provider.

The header name is an optional [profile contribution](docs/profile-authoring.md). The Pages menu discovers installed page plugins; packages can hide auxiliary-only contributions from that menu. Selecting a menu entry preserves the header galleon and does not change the selected implementation for a page slot.

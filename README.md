# Helmsman

A control plane for coding agents working from Jira and local task sources. Launch a CLI agent against a
task, watch it work live (explore → implement → test → open a PR), and keep a human
approval gate before anything merges — running multiple agents across repos, with one
run per repo by default and explicit opt-in for independent parallel work. The dashboard (backlog queue, current run, Ship’s log, shipped PRs)
is the view; the **Helmsman server** behind it spawns and supervises the agents.

The **Helm** dashboard brings together tasks, active agents, PRs and live logs. Its panels
can be rearranged, and one personal theme controls the interface. Pirate mode switches
application labels between nautical and plain language.

## Quickstart

Requires **Node.js 22.12+ on the 22 release line, or Node.js 24+**, npm and Git.

```sh
git clone https://github.com/nloehlein-godaddy/helmsman.git
cd helmsman
npm ci
cp .env.example .env
```

Skip the copy if you already have a `.env`; keep existing credentials and saved runtime data.
Edit `.env` before starting:

- Set `AGENTS_ROOT` to the parent directory of your local galleon checkouts. For
  `your-org/your-repo`, Helmsman expects `<AGENTS_ROOT>/your-repo`; it does not clone it.
- Set `GITHUB_TOKEN`, `GITHUB_PR_AUTHOR` and `GITHUB_REPO` for your GitHub account and
  galleon. Replace the example `REPO_PROJECT_MAP` with your mappings, or leave it empty
  if you do not use Jira. Organization tokens may require SSO authorization.
- To launch agents, install the selected agent CLI and configure `GOCAAS_API_KEY` or
  `GOCAAS_API_KEY_HELPER`. The default helper is `~/.gocode/bin/gocode`; CLI sign-in
  alone does not configure Helmsman's [managed model route](docs/model-routing.md).
  Install the required trusted `review-agent` skill (for example,
  `~/.codex/skills/review-agent/SKILL.md`) and ensure every selected reviewer CLI is
  installed. The default coding review gate selects both Codex and Claude Code. For
  a Codex-only setup, explicitly choose it before starting the server:
  `npm run plugins -- select-agent-reviewers helmsman.agent-codex/codex`.
  Missing required skills or selected reviewers block review preparation.
- Jira and Slack are optional. Leave their credentials blank if unused, and keep both
  automatic review watchers disabled until you have verified a manual run.

```sh
npm run dev
```

Open **http://localhost:43872**, select your galleon, then check its GitHub connection
and local checkout under **Config**. The API runs at **http://127.0.0.1:43871**.
Open **Bounties** (plain mode: **PRs**) to inspect a PR and start a review, or use
**Helm → New voyage** (plain mode: **New run**) for task work. Starting a review can
publish comments to GitHub; opening a page or inspecting a PR does not start one.
Missing integrations show unavailable or partial data, without sample-data fallback.

See [First-time setup](#first-time-setup) for credentials and checkout requirements,
[Configuration](#configuration) for settings, and the
[independent plugin quickstart](docs/plugin-quickstart.md) for authoring extensions.

## Features

- Jira and local Todos, manual task launches, and opt-in automatic starts.
- Isolated worktrees, durable run history, live logs, recovery, and bounded concurrency.
- Independent review before new coding voyages publish a PR; agents never merge.
- PR inspection, direct/team review inboxes, manual GitHub reviews, feedback updates
  and optional automatic reviews from GitHub or Slack.
- Global native-terminal viewing/control, configurable agent prompts, personal themes
  and replaceable page, provider, workflow and execution-host plugins.

## Plugin implementation status

Optional pages, panels and integrations use replaceable plugin contributions. Task sources, PR and communication providers, pricing, scheduling, agents, execution hosts, native terminal/browser providers, workflows and triggers have public contracts. Core retains scope, credentials, durable state, admission, budgets, concurrency, publication and recovery. Disabling a selected provider blocks new work without restoring a private fallback; saved layouts and existing obligations remain intact.

Triage offers **Assign to me** for supported unassigned Jira tasks. It uses the authenticated Jira account, preserves pending requests across reload/restart, and checks uncertain outcomes before retrying. [Plugin author contract](docs/task-source-authoring.md#remote-assignment-actions).

Phases A–G are complete. Optional features use public plugin contracts, obsolete new-work routes are retired, and the stable SDK includes independent-author examples and compatibility guidance. Initial acceptance passed, including the manual draft-review correction. The [second adversarial review](docs/adversarial-review-2026-09-21-round-2.md) subsequently found seven issues, including two P1s; the [second fix ledger](docs/adversarial-fixes-2026-09-21-round-2.md) records their corrections and validation. The [helmsman-og comparison](docs/helmsman-og-feature-evaluation-2026-09-21.md) identifies compatible feature updates. The [remaining-feature design](docs/helmsman-og-feature-design.md) defines the implementation batches, retained command boundaries and opt-in concurrency rollout. See the [implementation ledger](docs/plugin-implementation-progress.md) for accepted evidence and the [adversarial fix ledger](docs/adversarial-fixes-2026-09-21.md) for subsequent hardening, validation and platform limits.

Startup restores your previous configured galleon unless the URL specifies a scope. Without a valid saved choice, select a galleon before pages load. **All galleons** remains an explicit header option and is remembered when selected; it is not the first-use default.

**Agent Questions** pulses when unanswered, unexpired questions exist in the header galleon scope and you are on another application tab. A short chime plays once per new batch after browser interaction enables audio. Opening Questions silences the alert; returning to another tab keeps the highlight without repeating the same chime. Reduced-motion preferences use a static highlight. The selected questions plugin supplies this through an [optional public attention hook](docs/authored-clarifications.md#question-tab-attention).

The OG presentation ports add scoped Triage and Bugs descriptions, canonical Underway links to recorded runs and PRs, and accessible loading wheels in Running and Recent. The operator disclosure is in Config; Recovery and Pirate controls remain in the footer. Durable assign-self, [configured product feedback](docs/product-feedback.md), [live agent instructions](docs/run-instructions.md) and [opt-in same-galleon parallelism](src/plugins/execution-settings/README.md) are implemented. The [October integration ledger](docs/helmsman-og-integration-2026-10-01.md) records feedback completion audits, launcher fixes and presentation updates. New Underway Slack actions are excluded from this integration.

**Voyage logs** (Run logs with Pirate mode off) stays at the bottom of the application. Expand it to reopen saved log tabs; selecting a run opens it automatically. Collapse it to recover screen space and pause log polling. Drag the divider below its title to adjust the drawer height, or use the Resize log grip beneath the preview to size the log itself. Both controls support arrow keys and remember their heights. Freshly launched runs wait briefly for their log record to become available. Approve and Request changes recommendations can open a prepared GitHub review draft alongside the current diff; publishing still uses the bounty panel’s review controls. Metadata also shows the latest available review recommendation and its draft action. Merged and closed bounties hide the agent and review action sections. Repeating a review of the current commit requires changing the model or reasoning selection; optional review guidance is retained with the launch and sent to the agent. Voyage History identifies reviewed PRs by number and galleon, with their retained title when available. Older reviews without a saved title still link to their PR. Recent/running links preserve the header galleon.

Start with the [independent plugin quickstart](docs/plugin-quickstart.md), [package installation](docs/plugin-packages.md), [compatibility policy](docs/plugin-compatibility.md) and [retired routes](docs/plugin-legacy-retirement.md). The [voyage flow diagrams](docs/helmsman-process.md) describe current presentation, execution and recovery boundaries. [Prompt parity](docs/prompt-parity.md) documents shared role-specific instructions, retained acceptance briefs and review decisions, counterevidence checks, and focused verification. [Prompt evaluations](docs/prompt-evaluation.md) export blinded cases and score saved model predictions alongside the local parity check. Runs, history, the shared viewer and clarification panels are authored packages; `/runs` and `/prs` select compositions using public PR panels and the same auxiliary viewer.

The [authored question/contact guide](docs/authored-clarifications.md) describes the selected `/clarifications` composition, conditional draft/result saves and its always-visible compatibility recovery link. Original drafts and pending requests remain under their original caller in the independently buildable recovery package; the alias does not import or replay them. Renamed copies use their own storage namespace and request journals. The [public PR page and provider guide](docs/pull-request-authoring.md) describes independently buildable PR presentation, replaceable GitHub integration and durable manual-review requests. `/prs` and `/pr` select an authored composition. The [Runs package](src/plugins/runs/README.md) composes the public PR and history panels; separate header, PR and run targets remain intact. The [Communication authoring guide](docs/communication-authoring.md) covers the selected `/communication` composition, notification header, scoped reads and revision-checked settings, caller-owned exact retry, durable Slack requests, and the independently buildable Slack provider.

The [Terminal authoring guide](docs/terminal-authoring.md) covers the selected `/terminal` composition and `/cmux` alias, global terminal scope, revision-bound list/screen/control operations, bounded visible polling, explicit keyboard control, and durable browser/server receipts. Receipt checks never send input, and uncertain controls require inspection before the operator explicitly resumes later controls; the public service has no retry API.

The [Campaign authoring guide](docs/campaigns-authoring.md) covers replaceable campaign presentation, revision-checked mutations, explicit import previews, durable receipts and exact-request recovery. Core retains durable execution coordination; [trigger extraction](docs/trigger-authoring.md), reviewed and pushed through `12a62c9`, moves candidate ordering into a separately selected policy.

The [Local Git authoring guide](docs/local-git-authoring.md) covers scoped branches/worktrees, revision-pinned confirmations and durable command inspection without replay. Existing Config deep links select the replaceable `/local-git` page.

## Stack

TypeScript (strict). A **Vite** front end (pure logic in `src/logic/`, unit-tested with
Vitest; the shell and authored page/panel packages own their DOM) plus a persistent **Helmsman Node server**
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
npm ci                       # install the lockfile's dependencies
npm run dev                  # API :43871 + Vite UI :43872, proxies /api
npm run helmsman             # server; serves dist/ when built
npm run build                # TypeScript check + browser build to dist/
npm run build:distribution   # runnable server, UI, SDK and plugins in release/
npm run plugins -- list      # inspect installed plugin packages
npm test                     # unit tests
npm run test:browser         # browser tests
npm run test:distribution    # build + standalone distribution checks
```

## Execution flow

1. Select a task from Jira or local Todos, enter a free-form task, or inspect an existing PR.
2. Core checks scope, credentials, retained requests, budgets and capacity, then records
   the run in SQLite and prepares an isolated git worktree.
3. The selected agent works through the retained workflow. New coding voyages pass
   independent review before Helmsman pushes the reviewed commit and opens a PR.
4. Follow progress in the shared log viewer. Jira and Todos retain their own task state;
   SQLite retains execution, receipts, recovery and run history.
5. Review the result on GitHub. Helmsman never merges PRs.

Each galleon permits one run by default; **Config → Execution settings** can explicitly
allow independent parallel work within the global concurrency cap. Failed or stopped
work may retain its worktree and artifacts for recovery. See [Recovery](docs/recovery.md)
and the [workflow diagrams](docs/helmsman-process.md).

## First-time setup

1. Install **Node.js 22.12+ on the 22 release line, or Node.js 24+**, npm, and Git.
   These versions satisfy the current Vite and `better-sqlite3` requirements. If npm cannot use a prebuilt
   SQLite binary, install your platform's native build tools (Xcode Command Line Tools
   on macOS). Install `codex` (default) or `claude` on the Helmsman server's `PATH`.
   The shipped generic command adapter remains available for legacy recovery but does
   not support new managed runs. Managed model calls require `GOCAAS_API_KEY` or an executable
   `GOCAAS_API_KEY_HELPER` (default: `~/.gocode/bin/gocode`). Codex and Claude use fresh
   per-run configuration; signing into their CLI alone is insufficient. See
   [model routing](docs/model-routing.md) for supported endpoints and authentication.
   Install the trusted `review-agent` skill in a local skills directory such as
   `~/.codex/skills/review-agent/`. Helmsman also searches `.codex/skills`,
   `.claude/skills` and `.agents/skills` under its working directory and your home.
   Every selected reviewer CLI must be available; a missing skill or reviewer blocks
   the review gate. Install and authenticate GitHub CLI (`gh auth login`) for
   coding agents that open or update PRs. Git must also be able to fetch your private
   repositories using your SSH key or HTTPS credential helper.
2. From the Helmsman checkout, run:

   ```bash
   npm install
   cp .env.example .env
   ```

   Keep `.env` local and do not overwrite an existing file. The file is optional when
   configuration is supplied by the parent environment. Missing credentials leave the
   affected integrations unavailable. Run subsequent npm commands from this directory.
3. Create a parent directory for the repositories Helmsman will work in, and clone each
   repository into a directory matching its **repository name**, without the owner:

   ```bash
   mkdir -p /absolute/path/to/agent-repos
   git clone git@github.com:your-org/your-repo.git /absolute/path/to/agent-repos/your-repo
   ```

   Add `AGENTS_ROOT=/absolute/path/to/agent-repos` to `.env`. A configured repository
   `your-org/your-repo` resolves to `<AGENTS_ROOT>/your-repo`; its agent worktrees live
   under `<AGENTS_ROOT>/your-repo/.worktrees/<run-id>`. Helmsman does not clone missing
   repositories. Use an ordinary checkout with matching GitHub fetch and push URLs
   on its remote. Publication prefers `origin`; otherwise exactly one remote must match.
   Repositories with the same name under different owners cannot share
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
   email address. Without an explicit claim account, the source uses the authenticated
   Jira account. Match the `JIRA_STATUS_*` values to your workflow's actual status names.
   These values initialize the Jira source once; afterwards edit its policy in
   **Config → Source settings**. Map each tracked repository to its Jira project:

   ```dotenv
   REPO_PROJECT_MAP=your-org/your-repo=PROJECT,your-org/another-repo=OTHER
   ```

   Replace the organization-specific examples in `.env.example` with your values.
   Jira is optional for PR reviews and free-form voyages. Leave its credentials blank
   if you do not use it; Jira panels will identify unavailable data.
6. Leave both review watchers disabled for the initial check. Run `npm run dev` and open
   the printed Vite URL (normally `http://localhost:43872`). The API listens on
   `127.0.0.1:43871` by default. Select a galleon in the header, open
   **Config → Local branches & worktrees**, and verify the expected checkout.
   Check Helm/Bounties for live data and source errors. Resolve credential, checkout, and agent CLI
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

For an installation independent of the source checkout:

```sh
npm run build:distribution
node /absolute/path/to/helmsman/release/server/helmsman/main.js
```

Run the compiled server from a separate data directory containing your optional `.env`.
Keep databases, run files and worktrees outside `release/`. The distribution is specific
to its build OS, CPU architecture and Node major. See [Distribution](docs/distribution.md)
for upgrades, compiled plugin CLI commands and safe-start recovery.

The examples below use `npm run plugins -- <command>` from the source checkout. For a
compiled installation, use `node /absolute/path/to/release/server/helmsman/plugins/cli.js <command>`.

### Polling and external requests

The client loads repository metadata from the local `/api/context` endpoint.
Visible PR lists and run summaries poll the local server every five seconds; GitHub
list reads share a server-side cache of up to five minutes. Hidden panels pause polling.
Notifications poll every 15 seconds while visible, and the open log viewer polls every
two seconds while following output. Config does not repeatedly
reload settings or scan local worktrees. The selected cmux screen refreshes every two
seconds only while its page is visible.

Helm shows the latest 10 completed voyages in the current scope. **All voyages**
opens the full history, with up to 50 entries per page and Previous/Next controls.
Changing galleons or the status filter starts a new history observation.
Paging preserves the PR lookup draft and any open voyage logs.

The server shares GitHub list and review-history reads across tabs for five minutes,
coalesces concurrent requests, and pauses rate-limited reads until GitHub's reset.
Review preflight, PR details, diffs, and publication checks always use fresh requests.
Enabled Slack and GitHub requested-review watchers run independently of browser
visibility. Their selected trigger metadata supplies the interval; shipped packages
default to five minutes and expose `intervalMs` in plugin settings. The read-cache
periods above remain fixed in code. The selected scheduling plugin owns the separate opt-in ticket scheduler interval; see [scheduling plugins](docs/scheduling-authoring.md).

## Running agents

Launch a ready task from Helm or Todos, or start a PR review from Bounties.
Helmsman creates a git worktree under `AGENTS_ROOT`, starts the selected agent
(default: Codex), records the run in SQLite, and exposes its output in the shared log
viewer. The viewer uses bounded polling through public run services; stop and retry
controls retain durable command receipts. Completed worktrees are cleaned up when safe;
failed, stopped or otherwise retained work stays available for recovery. One run per repo by
default; Execution settings can opt into independent parallel runs. Global concurrency
is capped by `AGENT_MAX_CONCURRENCY`, and task/branch/PR/workspace collisions remain blocked. The agent opens a PR and
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
reviewer list with `npm run plugins -- select-agent-reviewers <plugin/id,...>`. Every
selected reviewer must be available and complete its review; a failure cannot
silently reduce the gate. The selected workflow package owns prompt templates and
guarded stage sequencing. Configure `maxRounds` (1–5) and `stageTimeoutMinutes`
(5–180) on `helmsman.workflow-coding`. Defaults are three rounds and 45 minutes per
session. Agent and workflow settings are captured at admission; changes do not
affect an existing voyage. Scheduling and automatic trigger policies are independently selectable plugins.

Reviewers inspect the same pinned commit in separate detached worktrees and focus
on material logic, structure, acceptance criteria, UX, and external effects. Codex and
Claude reviewers require the pinned `review-agent` skill; each CLI delegates relevant
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
Each author, fix, or reviewer session has a 45-minute timeout by default. The managed post-PR review still runs through GoCaaS after successful publication.
New Copilot or other external AI reviewer requests are not created.

See the [latest OG integration ledger](docs/helmsman-og-integration-2026-10-05.md) for portable continuation, theme palettes, and plugin form controls. Earlier integrations are linked there.

### Recent voyages

After a successful coding voyage opens a PR, Helmsman queues
its own independent adversarial review through GoCaaS as a separate voyage. The durable queue
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

Opening a voyage loads its latest 50 log entries. The preview retains at most 300
entries as updates or older pages arrive; long entries are shortened for display. **Download full log** retrieves all persisted output, including earlier
entries and full-length lines. For an active run, the download is a snapshot at
the time it is requested. The viewer follows the latest output by default; scrolling away
pauses following, and **Earlier logs** loads older entries. Collapsing the viewer pauses
its log polling.

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

PR inspection shows the title, author, state, checks and your submitted review status.
Expandable sections show discussion comments and requested changes; reviewer and check
counts expose their available details. Unknown or partial evidence remains labeled.
GitHub enforces the galleon's merge requirements; Helmsman does not infer a fixed
number of required approvals.

The **Bounties** tab (**PRs** with Pirate mode off) starts with PR inspection, followed
by **Review requests**, **My recent bounties** and collapsible recent PR voyages.
Requested rows distinguish **Direct** requests from named GitHub teams. Team matching
requires the authenticated account to match `GITHUB_PR_AUTHOR`; incomplete membership
or PR scans show partial coverage, and missing organization SSO authorization is called
out explicitly. Authored lists default to **Open**; **All** includes closed and merged
PRs. Open rows highlight requested changes and comments since the latest commit when
that evidence is available. Select a row to load its metadata and immutable diff.
The **Helm** page also lists open PRs for every author in the selected galleon.

**Crew work** (**Agent work** in plain mode) separates **Review** from **Update**.
Review guidance sits above **Start deckhand review** and **Explain in Whiteboard**;
Whiteboard opens or generates an explanation through its configured service. Repeating
a submitted review at the current commit requires a different model or reasoning
selection; a visible notice explains the disabled action. Update is available for your
own open PRs with a configured local checkout. Its editable feedback defaults to
“update the pr using the provided comment feedback.” and updates the existing branch.
Existing custom feedback is preserved. Slack review requests appear only while the
selected Slack connection is connected and the PR is owned by the configured user.

**Recent PR voyages** shows the latest 10 PR-related runs in the selected repository
from the local run history, with status and saved review results. Select a voyage to
open its output, or **All voyages** for the full list. It uses the existing local
refresh and preserves any unsent review while updating.

The **Inspect a bounty** form (**Review a PR** in plain mode) takes a number, URL or
`owner/repo#number`, including PRs not created by a Helmsman run. Metadata, agent work,
diff and your manual GitHub review are collapsible sections within the selected PR.
From the panel you can **Approve / Request changes / Comment** through durable public PR commands and — when the PR's
repo is checked out under `AGENTS_ROOT` — **Update branch with feedback**: the agent checks out the
existing PR branch, addresses the feedback, and pushes the **same** branch so the PR updates
(no new PR, no Jira claim). The feedback agent inventories all reviews, comments,
and threads, including paginated results, resolved/outdated threads, and non-blocking
suggestions. Each finding needs an accurate GitHub disposition: a verified fix with
its pushed commit and validation, or an evidence-backed reason for leaving it unchanged.
Existing accurate replies are linked instead of duplicated; a final PR comment accounts
for every finding. Optional suggestions do not require scope expansion or code changes.
The agent uses only authorized publication tools and reports any missing responses or
publication blockers; local reports alone do not establish completion. Reads and new
review/rerun preparation use the selected
PR provider, retaining its connection, settings, artifact and exact head. A missing
or changed selection blocks admission. Publication remains a guarded server-side
operation; credentials never reach the browser. **There is no Merge button** —
merge stays a deliberate action on GitHub, and the agent never merges.

The built-in branch workflow independently checks the published head and complete
discussion after each repair. Every source must be accounted for, with published
response evidence for each finding. Edited comments, review summaries, or owner
answers invalidate an earlier audit. Required decisions appear in Clarifications;
answered decisions must still be implemented and reviewed. Running and Recent show
**Feedback completed**, **Feedback remaining**, or **Awaiting decision** separately
from worker status. Successful process exit alone cannot complete feedback work.
The workflow retains its selected PR source, author, reviewers, and policy. Feedback
publication currently requires a trusted local execution host.

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

**Config → Agent prompts** edits the built-in workflow roles: implementation, repair, independent review, PR review, feedback authoring and feedback audit. Changes are global and apply to new runs; existing runs retain their original instructions. Each role supports a custom instruction block (up to 4 KiB) and restoring its built-in default. Helmsman still supplies task context, report formats and publication limits. See the [Agent prompts package](src/plugins/agent-prompts/README.md).

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
metadata. Select them with `npm run plugins -- select-agent <plugin/id>` and
`npm run plugins -- select-agent-reviewers <plugin/id,...>`. The shipped packages are
`helmsman.agent-codex/codex`, `helmsman.agent-claude/claude-code`, and
`helmsman.agent-command/command`. Configure package settings with `npm run plugins --
configure <plugin-id> '<json>'` before selection.

Provider metadata declares defaults, review tuning, skills/delegation, Docker
compatibility and whether costs are delta or cumulative. Codex defaults to
`gpt-6-astra`/medium; Claude Code uses provider defaults and native subagents. Both
declare the required `review-agent` skill. Command uses its namespaced `commandTemplate` setting.
The command template supports `{ticket}`, `{repo}` and `{title}`, is argv-only, and
an empty template never falls back to Codex. The shipped command provider declares no
managed model transport, so it cannot admit new managed runs; its retained settings
remain available for legacy recovery. A replacement provider must declare a supported
transport and honor the scoped gateway contract. Legacy `AGENT_ADAPTER` and `AGENT_CMD`
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
npm run plugins -- select-workflow coding helmsman.workflow-coding/coding
npm run plugins -- select-workflow review helmsman.workflow-review/review
npm run plugins -- select-workflow branch helmsman.workflow-coding/branch
npm run plugins -- configure helmsman.workflow-coding '{"maxRounds":3,"stageTimeoutMinutes":45}'
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

Use `npm run plugins -- select-native-terminal <plugin/id>` for terminal I/O and
`npm run plugins -- select-browser-host <plugin/id>` for optional browser integrations.
The shipped providers are `helmsman.terminal-cmux/cmux`,
`helmsman.native-firefox/firefox`, and `helmsman.terminal-wezterm/wezterm`; cmux and Firefox support browser primitives.
Selections are independent. Slack uses the GoCaaS/OI Companion MCP provider by default and requires no Firefox or cmux browser session. Browser-backed Slack remains an explicit legacy selection.
Configure `binary` and `socketPath` on cmux/WezTerm, or the exact credential-free loopback `bidiEndpoint` returned by an operator-created disposable Firefox WebDriver session. `TERM_BRIDGE`,
`CMUX_SOCKET_PATH`, `WEZTERM_BIN` and `WEZTERM_UNIX_SOCKET` seed initial settings once.
Existing terminal receipts never resend input after provider changes or disablement.
See [native terminal authoring](docs/native-terminal-authoring.md).

### Execution hosts

Select a host with `npm run plugins -- select-execution-host <plugin/id>`. The shipped
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

`AGENT_MAX_ATTEMPTS` bounds retries for direct existing-PR voyages. New coding voyages
and built-in feedback updates use one coordinator attempt with bounded review rounds
from the retained workflow settings. `AGENT_MAX_COST_USD` (opt-in)
stops work once reported cost reaches the cap. Pre-PR voyages aggregate reported
cost across author and reviewer sessions. Cost enforcement depends on validated
provider-reported cost; absent cost data cannot bound spend. Both, and the live attempt/cost of
each run, show on the running-agent rows (`×attempt/max`, `$cost/$cap`).

### Resilience

On startup Helmsman reattaches to surviving run hosts and marks interrupted runs
failed when their host is gone. It sweeps orphaned agent worktrees under each repo's
`.worktrees/`, except failed or stopped pre-PR and feedback voyages retained for recovery.
Retrying a failed feedback voyage starts from the current published PR head and
detaches its inactive retained checkout, preserving unpublished commits and staged,
unstaged, and untracked files for inspection. These
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
`.env` require a restart to be loaded. The scheduler interval belongs to the selected scheduling plugin; configure its
`intervalMs` setting and follow the CLI restart instruction. Legacy watcher flags seed trigger settings
once; they are not live controls. Slack and GitHub settings show read-only watcher
status and direct configuration to the selected trigger plugin. Follow the plugin
CLI restart instruction after changing trigger settings.

### Jira

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `JIRA_ENABLED` | `true` | Initial source enablement. Afterwards manage the source in Config → Source settings; Todos remains independent. | Initial conversion |
| `JIRA_BASE_URL` | Empty | Jira Cloud site URL, e.g. `https://your-team.atlassian.net`. Required with email and token for initial connection provisioning. | Restart |
| `JIRA_EMAIL` | Empty | Email of the API-token owner; supplied in the server environment. | Restart |
| `JIRA_API_TOKEN` | Empty | Atlassian API token with the necessary browse/assign/transition permissions. The Jira connection page accepts a revision-checked replacement without returning it. Empty updates are rejected. | Restart for environment changes; live write-only replacement |
| `JIRA_PROJECT` | `AIROBUILD` | Initial default project; `REPO_PROJECT_MAP` seeds per-galleon project mappings. | Initial conversion; then Source settings |
| `JIRA_ASSIGNEE` | `currentUser()` | Initial task-list assignee filter. | Initial conversion; then Source settings |
| `JIRA_JQL` | Empty | Additional task-list filter and optional ordering. Project, assignee and state constraints still apply. | Initial conversion; then Source settings |
| `BOT_ACCOUNT_ID` | Authenticated Jira account | Initial claim assignee. A supplied value must be a Jira account ID, not an email. | Initial conversion; then Source settings |
| `JIRA_STATUS_IN_PROGRESS` | `In Progress` | Initial working status used for claims and task views. | Initial conversion; then Source settings |
| `JIRA_STATUS_IN_REVIEW` | `In Review` | Initial review status after successful ticket work. | Initial conversion; then Source settings |
| `JIRA_STATUS_BACKLOG` | `Backlog` | Initial Backlog-column status and one of the ready statuses. | Initial conversion; then Source settings |
| `JIRA_STATUS_TODO` | `To Do` | Initial To do-column status and one of the ready statuses. | Initial conversion; then Source settings |

Jira source settings retain their project mappings, assignee, additional JQL and
workflow statuses independently of the bootstrap environment. Changing a seed in
`.env` does not replace an existing source. Use Source settings for ongoing policy
changes and the Jira connection page for token replacement.

### GitHub and repository scope

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Empty | GitHub token used by the server for API reads and review publication. See setup for repository access and permissions. Never displayed or editable in Config. | Restart |
| `GITHUB_PR_AUTHOR` | Empty | GitHub login used for authored PRs and review requests. Both this and `GITHUB_TOKEN` must be nonempty for GitHub to be configured. | Live |
| `GITHUB_REPO` | Empty | Optional `owner/name` repository added to tracked repositories and automatic-review eligibility; also supplies the default repository label. With no repo, the label falls back to `@<author>`. | Live |
| `REPO_PROJECT_MAP` | Empty | Comma-separated `owner/name=PROJECT` pairs for tracked galleons and automatic-review eligibility; seeds Jira source project mappings once. Existing Jira mappings belong to Source settings. | Live tracked scope; initial Jira source conversion |
| `GITHUB_REVIEW_WATCH_ENABLED` | `false` | Seeds GitHub review trigger enablement once. Subsequently configure the selected `github-review` trigger. Existing pending requests can launch when enabled. | Initial conversion |

### Slack GoCaaS/OI Companion

The default `helmsman.slack-companion/slack` provider uses the Slack MCP service
behind [Slack GoCaaS/OI Companion](https://godaddy-corp.atlassian.net/wiki/spaces/xform/pages/4509107536/Slack+GoCaaS+OI+Companion+Overview).
It needs no browser bridge. Supply a user-delegated Slack OAuth token through the
secure server environment as `SLACK_MCP_TOKEN`; this is separate from the GoCaaS
model API key. Credentials never belong in Communication settings or plugin settings.
Helmsman does not implement OI's OAuth sign-in flow or automatically discover an OAuth
issuer. Missing or expired credentials leave Slack unavailable until replaced.

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `SLACK_MCP_URL` | `https://mcp-slack.goarena.gdcorp.tools/mcp` | Companion MCP endpoint; test uses `https://mcp-slack-test.goarena.gdcorp.tools/mcp`. | Restart |
| `SLACK_MCP_TOKEN` | Empty | User-delegated Slack OAuth token supplied to the server. Never use `GOCAAS_API_KEY` here. | Restart |
| `SLACK_WATCH_ENABLED` | `false` | Seeds Slack review trigger enablement once. Subsequently configure the selected `slack-review` trigger. The communication source and Companion credentials must also be available. | Initial conversion |
| `SLACK_CLIENT_ID` | Empty | Slack workspace ID, typically beginning with `T`, from the first identifier after `/client/` in a Slack URL. This is not an OAuth app client ID. | Live |
| `SLACK_CHANNEL_ID` | Empty | Channel identifier from the Slack channel URL; must match the channel being watched. | Live |
| `SLACK_CHANNEL_NAME` | Empty | Channel name without `#`, using lowercase letters, digits, `_`, or `-`. | Live |
| `SLACK_BROWSER_SURFACE` | Empty | Legacy browser provider only: optional native browser surface reference. Ignored by Companion. | Live |

The watcher starts disabled. See [Automatic PR reviews](#automatic-pr-reviews) for
channel setup and trigger activation. Explicit legacy browser selection remains
available with `npm run plugins -- select-communication helmsman.slack/slack`; its
signed-in browser requirements still apply. A one-time upgrade switches the old shipped
`helmsman.slack/slack` selection to Companion; custom selections stay unchanged, and
explicitly reselecting the browser provider after migration persists. Changing providers
does not move pending
requests: retained operations resolve through their original provider and artifact.

### Connect your Slack account through OAuth

The direct MCP provider also supports **Connect Slack**, **Check connection**, and
**Disconnect Slack** in Communication settings. This option requires an approved
Slack application with user scopes `channels:read`, `chat:write`, and `search:read`.
It does not request bot, message-history, or user-profile scopes.

Configure `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`,
`SLACK_OAUTH_REDIRECT_URI`, `SLACK_OAUTH_TOKEN_FILE`, and the existing
`SLACK_CLIENT_ID` workspace ID in the server environment. Register an exact HTTPS
callback ending `/api/communication-connection/callback` and route that approved
HTTPS address to this instance. Open Communication settings at that same HTTPS
address to connect. The token file must have an absolute path in a private,
user-owned directory; the provider stores credentials privately and refreshes
expiring user tokens. Secrets are never entered into plugin settings or browser
storage.

Explicit OAuth configuration disables fallback to an environment token.
Disconnect invalidates the connection and pauses queued automatic reviews;
reconnection never silently retargets retained sends. Existing externally supplied
`SLACK_MCP_TOKEN` configurations continue to work. The OI provider below remains a
separate option and has its own deployment requirements.

### OI Slack Companion without a Helmsman Slack app

The opt-in `helmsman.slack-oi/slack` provider calls OI's hosted
`godaddy-slack-companion` using your existing Slack authorization in OI. It needs
an OI credential, its OAuth session cookie and personal Slack consent in OI, but no separate Helmsman Slack
app or exported Slack token. Direct MCP remains the default; installing this
provider does not select it or migrate existing requests.

**Production currently blocks automated use:** its `/api/config` reports native
tool approvals disabled. Helmsman refuses to create a tool request without that
capability. A successful OI login or model listing does not prove Slack delivery.

| Value | Default | Purpose |
| --- | --- | --- |
| `SLACK_OI_URL` | `https://caas.open-webui.godaddy.com` | OI endpoint. |
| `SLACK_OI_TOKEN` | Empty | OI credential, never a Slack token or `GOCAAS_API_KEY`. |
| `SLACK_OI_TOKEN_FILE` | Empty | Alternative absolute path to a user-owned file (mode `0600`) containing the OI credential. |
| `SLACK_OI_AUTH_MODE` | `bearer` | `bearer` or `sso-jwt`, matching the OI credential. |
| `SLACK_OI_OAUTH_SESSION_ID` | Empty | OI `oauth_session_id` cookie value required to access your connected Slack account. |

Keep both credentials in the secure server environment; Helmsman does not extract
browser cookies or refresh OI sessions. Run `npm run slack:oi:check` with both
credentials configured to check availability.
This preflight is read-only and makes no model call or Slack request. After the
OI deployment enables native tool approvals, select the provider explicitly:

```sh
npm run plugins -- select-communication helmsman.slack-oi/slack
```

Restart after credential or provider changes. Workspace, channel and reviewer
group settings still use Slack IDs. See [Communication authoring](docs/communication-authoring.md#oi-slack-companion)
for the approval boundary and delivery evidence requirements.

### Requesting reviews in Slack

Owned open PRs link to the authored Communication page with that PR selected. Its
review-request panel displays the exact provider artifact, workspace, channel, group,
and connection before Send. The caller-scoped browser journal reserves the complete
request before transport. Lost responses retain that identity for receipt lookup or
exact Retry; missing journal entries send nothing.

Configure the workspace and destination in **Communication settings**. Companion
requires a Slack user group ID beginning with `S`; it cannot resolve group handles.
Replace any retained `airo-editing-squad` handle with that group's ID before sending.
The review channel must be a channel ID beginning with `C` or `G`; replace any
retained channel name. Saving checks the displayed settings revision and never sends. Requests use the selected Companion connection; Slack
watching and explicit review-request sends can be enabled independently.
Helmsman does not invoke reaction or deletion tools.

| Value | Default | Purpose |
| --- | --- | --- |
| `SLACK_REVIEW_CHANNEL` | `airo-editing` (legacy) | Companion requires a channel ID (`C…` or `G…`); replace the legacy name before sending. Legacy browser provider accepts names or IDs. |
| `SLACK_REVIEW_MENTION` | `airo-editing-squad` (legacy) | Companion requires a user group ID (`S…`); replace the legacy handle before sending. Legacy browser provider accepts handles. |

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
| `PRE_PR_REVIEWER_COUNT` | `2` | Legacy count seeds the explicit ordered agent reviewer list once, preserving an existing explicit list. Subsequently use `npm run plugins -- select-agent-reviewers ID[,ID...]`; `default` resets to shipped defaults without reimporting the old count. | Bootstrap only |
| `PRE_PR_MAX_ROUNDS` | `3` | One-time seed for `helmsman.workflow-coding` setting `maxRounds` (1–5). Afterwards configure the package; explicit settings and resets are preserved. | Bootstrap only |
| `PRE_PR_STAGE_TIMEOUT_MINUTES` | `45` | One-time seed for `helmsman.workflow-coding` setting `stageTimeoutMinutes` (5–180). Afterwards configure the package; explicit settings and resets are preserved. | Bootstrap only |
| `AGENT_MAX_CONCURRENCY` | `3` | Maximum simultaneous runs across repositories. Each galleon defaults to one run; Execution settings can explicitly raise its limit within this global cap. | Restart |
| `AUTO_CLAIM_INTERVAL_MS` | `60000` | One-time migration seed for the shipped scheduling plugin’s `intervalMs`. Does not enable automatic starts or control PR watchers. | Bootstrap only; then configure plugin settings |
| `AGENTS_ROOT` | Server working directory | Parent directory of target repo checkouts, e.g. `/absolute/path/to/agent-repos`; not the path to a single checkout. | Restart |
| `RUNS_DIR` | `<AGENTS_ROOT>/.helmsman-runs` | Directory for detached-run specifications, logs, and exit records. Created on startup; use a writable absolute path. | Restart |
| `RUN_HOST` | Detached process | One-time execution-host selection seed: `detached`, `cmux`, `wezterm` or `docker`. Unknown names fail; unavailable hosts never fall back. After migration use `npm run plugins -- select-execution-host`. | Bootstrap only; then plugin selection and restart |
| `HELMSMAN_DB` | `<server working directory>/.helmsman.sqlite` | SQLite file for runs, config overrides, watcher state, and notifications. Use a writable path and retain it across restarts. A saved Jira token is stored here, so treat this file as sensitive. | Restart |
| `HELMSMAN_PORT` | `43871` | Local API/static-server port, bound to `127.0.0.1`; the Vite API proxy uses the same value. | Restart server and Vite |
| `HELMSMAN_UI_PORT` | `43872` | Vite development and preview UI port; an occupied port stops startup instead of selecting another port. | Restart Vite |
| `HELMSMAN_PLUGINS_DIR` | `~/.helmsman/plugins` | Plugin store shared by the server and plugin CLI. Set it explicitly to keep separate installations isolated. | Restart server; use the same environment for CLI commands |
| `VPN_CHECK_URL` | Empty | Optional credential-free, VPN-only HTTPS endpoint for a three-second HEAD reachability check. macOS GlobalProtect status is checked separately. | Restart |

### Browser preferences

Config's appearance editor manages one personal theme. Hue, saturation, brightness,
color harmony and the sun/moon appearance control derive the UI palette; five-color
presets offer starting points. Changes preview live, **Save theme** persists them in
this browser, and **Discard** restores the saved appearance. Advanced overrides include
an independent input background. Text and input colors adapt for contrast; error,
success, review and queued states remain red, green, blue and yellow. See
[theme palettes](docs/themes.md).

Pirate mode defaults on and can be toggled in Config or the footer. It changes
application labels, leaving user content, logs, code and technical identifiers intact.
The selected galleon, panel layouts, collapsed panels and log heights also persist
locally. Helm panels can be dragged by their headers or reordered with keyboard
controls. Browser preferences have no `.env` keys and are not shared between browsers.
Per-voyage model/effort choices belong to the launch form.

The VPN icon beside the notification bell reports the server machine's connection,
checked once a minute. On macOS it reads GlobalProtect status. Set optional
`VPN_CHECK_URL` to a credential-free, VPN-only HTTPS health endpoint for an additional
reachability check; no redirects are followed and checks time out after three seconds.
The icon explains unknown or unconfigured evidence. Restart after changing the URL.

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
> Managed stages receive temporary run-scoped model credentials; the model route removes
> host GoCaaS, direct model and Slack credentials and creates fresh CLI configuration.
> Helmsman makes Jira writes itself. Only point `AGENTS_ROOT` at repos,
> and only launch tickets, you're willing to let an autonomous agent modify on this machine.

### Unavailable integrations and local Git

Missing or invalid credentials leave the affected provider unavailable. Pages distinguish
unavailable data, partial results and confirmed empty lists; they do not substitute mock
tickets or PRs. Local Todos and other configured providers remain independently usable.
Review requests and other retained commands keep their original identity so an uncertain
outcome can be checked before retrying. Use [Recovery](docs/recovery.md) for retained work.

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

Both sources persist their queues and notifications in the Helmsman SQLite database. The header notification bell shows source health, queued/started/failed/blocked reviews, links to the source and run, and the selected model/effort. Marking a notification read persists across reloads and restarts. **Clear all notifications** dismisses the selected galleon’s history, or all configured galleons when All is selected. Dismissal persists across reloads and restarts, including older history beyond the displayed page. It preserves work queues, review deduplication and run records; notifications arriving after the displayed snapshot remain available. Existing concurrency limits apply; repositories must be configured in `GITHUB_REPO` or `REPO_PROJECT_MAP`. Requests for unconfigured repositories remain visible as blocked.

Incoming automatic Slack reviews skip PRs authored by the account authenticated by the selected GitHub connection. Missing identity remains queued. This does not change the configured-author policy for manual outgoing review requests.

Both watchers start disabled. For Slack, configure `SLACK_MCP_TOKEN` on the server
and restart. The default Companion provider reads Slack through MCP without a browser.
Copy the workspace and channel identifiers from a Slack channel URL:

```text
https://app.slack.com/client/<workspace-id>/<channel-id>
```

Set `SLACK_CLIENT_ID` to the workspace ID, `SLACK_CHANNEL_ID` to the channel ID, and
`SLACK_CHANNEL_NAME` to its name without `#`. Save these fields before enabling the
watcher. A review group ID is needed only for outgoing review requests.

The initial `.env` values are deliberately empty/disabled:

```dotenv
SLACK_MCP_TOKEN=
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
npm run plugins -- configure helmsman.trigger-slack-review '{"enabled":true}'
npm run plugins -- configure helmsman.trigger-github-review '{"enabled":true}'
```

Enable only the sources you want. Slack and GitHub settings display watcher status;
the old environment flags initialize settings once and do not override later changes.
Check the notification bell's source health. Only new Slack history after activation
is eligible; a full URL such as `https://github.com/your-org/your-repo/pull/123` is a
trigger. GitHub-only discovery needs no Slack fields or browser and can immediately
launch reviews for existing pending requests. Automatic reviews publish to GitHub.

Use `npm run plugins -- select-trigger <role> <plugin/id>` to replace a policy, with
roles `campaign`, `slack-review`, `github-review` and `github-webhook`. `default`
restores that role's shipped selection; `disabled` or `null` disables it. Explicit
unavailable selections do not fall back. See [trigger authoring](docs/trigger-authoring.md)
and [webhook setup](docs/webhooks.md) for route settings and core credential rotation.
Trigger extraction is reviewed and pushed through `12a62c9`.

Companion scans use the configured channel through MCP. Missing permissions,
expired credentials, or incomplete results appear in source health; incomplete scans
do not advance the successful scan watermark. Five minutes is a target while the
machine and server are running. Slack search indexing may add delay.

Only the explicit legacy `helmsman.slack/slack` provider needs a signed-in tab in
the selected browser host. Its cmux tab discovery or optional
[Firefox setup](src/plugins/native-firefox/README.md) remains available for that
provider and retained obligations. Browser scans can affect unread state.

Review model selection defaults to these tiers for Codex:

| Complexity | Model | Effort | Signals |
| --- | --- | --- | --- |
| Low | `gpt-5.6-terra` | low | Default, including large changes confined to one area or unavailable scope |
| Medium | `gpt-5.6-sol` | medium | More than 5 files or 300 changed lines, spanning multiple areas |
| High | `gpt-6-astra` | high | Explicit selection for serious architecture changes; never selected automatically |

Automatic routing is limited to low and medium. File size, sensitive paths, and unavailable diffs do not trigger high effort. Claude Code uses Sonnet for low/medium and Opus for high; the command adapter keeps its own model behavior. Explicit selections in PR controls override automatic tuning. The assessed revision, model, effort, complexity, and reason are saved with the run; review checkouts are pinned to that revision.

Reviewers reserve request-changes recommendations for demonstrated material logic,
structural/integration defects, or missed explicit material acceptance criteria.
The goal is a reliable implementation for customers, not perfection. Suggestions
stay within ticket scope; any necessary expansion must explain the material
requirement or customer regression it addresses and propose the smallest sufficient fix.
Credible rare edge cases appear as brief **Non-blocking** summary notes, outside
findings arrays, and do not prevent approval or trigger another fix round. A rare
case blocks only with evidence of a material requirement failure or serious customer
harm. Reviewers omit standalone test/doc/style suggestions and speculative hardening.
A lead passes these rules to delegates covering
applicable logic, acceptance/tests, UX, and external-effects scopes, then verifies
and deduplicates findings. Codex and Claude review runs pin the required `review-agent`
skill. Codex uses skill-based leaf reviewers; Claude uses native subagents. The lead alone
writes the output files. Missing required skills fail preparation; a reviewer that
cannot access a pinned skill or delegation tools reports a COMMENT limitation. Low effort remains the default for scoped workers; high effort
is reserved for serious architecture changes. See the [five-review calibration
audit](docs/reviewer-calibration-2026-09-17.md) for examples and rationale.

Reviews prefer inline findings on the relevant diff lines, with concrete fixes when supported by the code. Exact replacements use GitHub suggestion blocks; broader changes use code examples. The agent writes a concise summary to `.agent-review.md` and a JSON array of inline findings to `.agent-review-comments.json`. Helmsman validates the anchors against the reviewed revision and submits the summary and inline findings together as one COMMENT review. Findings that cannot be safely anchored remain in the summary. If the PR head changed, inline publication fails rather than attaching stale findings to new code. Existing summary-only output remains supported. Reviews do not push code or approve/merge PRs.

Model roles and effort guidance: [official OpenAI model documentation](https://developers.openai.com/codex/models/). Model availability depends on the account/provider.

The header name is an optional [profile contribution](docs/profile-authoring.md).
Page tabs expose the installed page compositions and preserve the header galleon.
The Terminal page shows the connected terminal globally; returning to another page
restores the header selector and its selection.

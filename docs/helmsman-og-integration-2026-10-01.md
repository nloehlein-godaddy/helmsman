# Pre-rewrite parity audit — 2026-10-01

Source: `nathanloehlein/helmsman-og`, `pre-rewrite` at `c42a9441cda4e8145dfb04b81b9722b89755cf0a`.
Comparison ancestor: `e471d86630d78f2285611e81256ff912e5f57d0e` (52 subsequent commits).
Rewrite base: `fix/adversarial-review-2026-09-21` at `e51419d0e880ed747dbf8a121a0e85c2a36565e0`.

Current integration: non-Slack ports from the combined parity branch are integrated into that rewrite branch. The new Underway Slack action and Slack OAuth link adjustment are excluded at the user’s request. Existing Slack launch code only gains the awaited admission call required by the shared concurrency contract.

The ports retain provider-owned commands, immutable artifact bindings, public SDK services, optional independently buildable plugins, and core-owned persistence/recovery. They do not replace the rewrite architecture with the old application modules.

## Commit disposition

| Source | Change | Rewrite disposition |
| --- | --- | --- |
| `3a79ee1` | Bump Helmsman version to 0.3.0 | Superseded: retain rewrite version 0.4.0. |
| `1e155c7` | Move operator disclaimer to the bottom of Config | Intentional presentation difference: the redesigned Config introduction keeps the operator disclaimer visible. |
| `8b12cb9` | Update 0.3.0 README and workflow diagrams | Superseded by rewrite documentation and provider/composition architecture. |
| `4daaa5d` | Clarify Docker-only host failure in workflow chart | Superseded by retained execution-host documentation and explicit host admission failures. |
| `41365fd` | Add brief Helmsman overview and feature summary | Superseded by the rewrite README and author guides. |
| `87c5dee` | Support Firefox Slack requests and contextual Underway actions | Excluded from this integration: #20 remains separate. Existing canonical Underway run/PR links and the optional operator-owned Firefox provider remain available. |
| `7439d34` | Clarify Firefox bridge recovery after app restarts | Superseded: Firefox BiDi remains operator-owned; core does not adopt or restart browser sessions. |
| `901c57c` | Confirm Firefox tab selection and handle file-only Slack messages | Intentional provider difference: direct MCP uses channel identities and text scanning. Firefox remains independently selectable. |
| `8896453` | Reconnect run output when launch preparation races log subscription | Already covered by the public run-inspection service and viewer polling across launch preparation. |
| `1740021` | Keep Firefox Slack automation in background tabs | Superseded by the selectable Firefox provider and direct MCP/OI transport boundaries. |
| `012b420` | Expand Jira ticket descriptions and add triage assignment | Already ported: rich Jira descriptions and assign-self through the retained task-source contract. |
| `2537b91` | Preserve Jira severity identifiers in compact badges | Already ported: Jira severity identifiers retained in compact presentation. |
| `6e9d1bf` | Add reusable reversing helm wheel loading indicator | Intentional styling difference: retain continuous helm rotation. |
| `6dcb2ea` | Preserve dashboard unavailable status announcement | Already covered by dashboard unavailable-state announcements. |
| `e12e406` | fix(slack): use trusted background Firefox pointer actions | Superseded by operator-owned browser providers; direct MCP/OI is the current integration. |
| `e18dbeb` | test(slack): verify failed native clicks are never replayed | Preserved through durable communication command identity and uncertain-send reconciliation; failed native clicks are not replayed by core. |
| `8d64111` | Add Helmsman feedback submission beside the pirate flag | Ported in #19 by the optional product-feedback plugin and GitHub Issues tracker; disabled by default. |
| `459a207` | Allow parallel voyages with task and branch reservations | Ported in #18 by parallel execution: per-galleon policy and durable task/branch/PR/workspace ownership. |
| `b31e2f4` | Guard feedback completion and uncertain submission failures | Ported in #19 by the product-feedback operation ledger, caller journal, and reconciliation without duplicate creation. |
| `bc239de` | fix(slack): scroll background controls into view before clicking | Superseded by operator-owned Firefox and direct MCP/OI provider behavior. |
| `3e3e593` | Preserve PR reservations when recovering incomplete run metadata | Ported in #18 by conservative legacy ownership, schema readiness, and retained workspace identity receipts. |
| `ce2f0c7` | Verify adjacent feedback and accessible pirate footer controls | Ported in #19 by adjacent feedback/Pirate footer controls and accessible feedback pages. |
| `4ca712a` | Skip automatic Slack reviews of own pull requests | Already ported: automatic review excludes the authenticated author’s own PRs. |
| `6c03e27` | Populate authored PR review and comment counts | Already ported through the GitHub provider and public PR read contract. |
| `121949d` | Show authored PR approval change request and comment counts | Already ported: authored PR approval, change-request, and comment counts. |
| `f8d74f3` | Add Firefox bridge status and startup controls | Intentional replacement: direct MCP/OI; legacy Firefox remains operator-managed without core Check/Start controls. |
| `1136c7e` | fix: keep Slack message links from opening PR rows | Already ported: explicit selection controls keep message links independent from PR-row actions. |
| `8d993a0` | Align PR list details and Slack request status in stable rows | Already ported: responsive PR rows; durable communication status remains in the Communication plugin. |
| `9e205c5` | Keep review feedback scoped and rare edge cases advisory | Already ported: review materiality and advisory rare-edge guidance. |
| `2341e3c` | Require GoCaaS routing for GoDaddy agent runs | Already ported: scoped GoCaaS routing. Interactive instruction children use the same routing enforcement. |
| `ba71dc6` | Add Slack MCP transport and user OAuth connection | Already ported: optional direct-MCP Slack user OAuth and private credential storage. |
| `59d0321` | Keep Slack review queue paused after OAuth disconnect | Already ported: disconnect blocks new watching/sends without credential fallback. |
| `7d4eab2` | Limit Slack OAuth to the scopes used by public-channel reviews | Already ported: minimal public-channel Slack OAuth scopes. |
| `d4987c3` | Show review recommendations in completed run tabs | Already ported: review recommendations in completed run tabs. |
| `f9ba17f` | Rerun incomplete reviews when continuing preserved runs | Already ported: explicit continuation reruns incomplete reviews with new immutable evidence. |
| `bc92817` | Record workflow upgrades on explicit run continuation | Already ported: explicit workflow upgrades are recorded while retained plugin artifacts stay pinned. |
| `530b961` | Allow releasing branches from idle worktrees | Already ported: idle branch release preserves workspace contents. Parallel execution adds ownership-fenced detachment and interrupted-detachment recovery. |
| `e6f509f` | Require GitHub responses for every PR feedback finding | Already ported and strengthened by #14: individual dispositions, coverage evidence, and independent completion checks. |
| `0bc78f8` | Resolve bare PR numbers against selected repository | Already ported: bare PR numbers use the selected header galleon. |
| `4195a69` | Expose agent exit codes and termination signals in run logs | Ported in #15: guarded process exit-code and signal diagnostics. |
| `49ab71b` | Preserve exit reporting if diagnostic logging fails | Ported in #15: diagnostic logging failures cannot prevent durable settlement. |
| `925527a` | Chunk GoCaaS launcher arguments to prevent startup termination | Ported in #15: bounded Unicode-safe launcher argument chunks preserve retained-host remapping. |
| `1db4311` | Support Enter for bounty lookup and collapsible voyage history | Ported in #16: Enter lookup guards. Existing composition Hide/Show offers an adapted equivalent; the exact OG inline collapse interaction is not implemented. |
| `f712c76` | Keep deckhand tasks visible on tall viewports | Ported in #16: tall-viewport sticky viewer. |
| `1702d25` | Send live instructions to active voyage agents with delivery receipts | Ported in #17: retained local Codex/Claude live instructions with exact attempt/channel/target receipts. |
| `5691965` | Resolve instruction receipts when voyages finish during send | Ported in #17: late acknowledgments reconcile uncertain sends even after run completion. |
| `3af194d` | Apply the saved theme to the loading screen before first paint | Ported in #16: saved theme applied before first paint. |
| `9f16e6c` | Show the reviewed PR number when reopening voyage tabs | Ported in #16: reopened review tabs retain the PR number. |
| `d16094e` | Compact voyage tabs and open external links in new browser tabs | Ported in #16: compact tabs and protected canonical links opening a new tab. |
| `647c09c` | Verify PR feedback completion with independent audits and decision handoffs | Ported in #14: independent feedback completion audits and decision handoffs. |
| `59b0821` | Preserve clarification evidence and unfinished work across feedback retries | Ported in #14: preserve clarification evidence and unfinished work across retries. |
| `c42a944` | Merge pull request #8 from nathanloehlein/fix/feedback-completion | Merge of the feedback-completion source changes above; no separate behavior. |

## Review branches

| PR | Behavior | Base |
| --- | --- | --- |
| [#14](https://github.com/nloehlein-godaddy/helmsman/pull/14) | Feedback completion audits, decision handoffs, retry evidence | Rewrite branch |
| [#15](https://github.com/nloehlein-godaddy/helmsman/pull/15) | Launcher argument chunks and exit diagnostics | #14 |
| [#16](https://github.com/nloehlein-godaddy/helmsman/pull/16) | Theme, tabs, external links, tall-view layout, Enter lookup | #14 |
| [#17](https://github.com/nloehlein-godaddy/helmsman/pull/17) | Live instructions and delivery receipts | #15 |
| [#18](https://github.com/nloehlein-godaddy/helmsman/pull/18) | Opt-in parallel execution and durable resource ownership | #14 |
| [#19](https://github.com/nloehlein-godaddy/helmsman/pull/19) | Configurable product feedback and submission recovery | #14 |
| [#20](https://github.com/nloehlein-godaddy/helmsman/pull/20) | Contextual Underway Slack review action — excluded | #14 |

## Operational boundaries

- Live instructions require a retained local Codex/Claude provider declaring the interactive protocol. Isolated runs and older providers report unavailable. Only an acknowledgment proves delivery; uncertain requests retain their identity.
- Product feedback starts disabled. Config settings apply after restart, consistent with backend provider binding. Existing submissions keep their original destination and are reconciled without duplicate creation.
- Parallel execution starts at one run per galleon and never raises the global cap. Existing per-run cost caps remain per run; there is no aggregate dollar reservation. Unverified/custom hosts remain exclusive. Retained schema-1 consumers and workspaces can block opt-in while the compatible runtime continues operating.
- Git cleanup requires retained allocation identity and a current owner. A crashed maintenance owner leaves a lock for verified recovery; elapsed time alone never authorizes another mutation.
- Non-Slack ports are now integrated into the rewrite working branch. Neither running application was restarted; operators must restart to load backend changes.

## Validation and review

The following results describe the earlier combined parity checkout, including its separate Slack action. Current non-Slack integration and notification validation are recorded in the [completion ledger](plugin-implementation-progress.md).


The combined integration checkout passed **5,811 tests across 427 files**, TypeScript and the production app/distribution build. Seven browser scenarios cover desktop/mobile run presentation and live instructions, execution-policy opt-in, Underway review requests, and product-feedback configuration/draft/reconciliation flows. Final mobile screenshots were inspected. The seven unique SDK compatibility fixtures and eleven distribution checks passed; the frozen SDK baseline was not changed.

The pre-PR runtime integration suite remains excluded from the full-suite gate because four continuation tests already failed on the unchanged base with null child exit codes. This is a known baseline limitation, not a passing result.

Every feature commit received a post-commit architecture review. Corrections include late legacy-checkpoint ownership, safe retained-workspace allocation checks, interrupted detachment recovery, editor focus preservation, exact Codex protocol fields, feedback footer lifecycle/accessibility, and responsive action/footer spacing. Shared integration conflict resolutions received an additional independent static review.

All browser/network acceptance used fixtures. No real feedback issues or Slack messages were submitted, and no user workloads were launched. Shared registration conflicts were resolved in the local `integration/post-rewrite-parity` checkout for combined validation; the focused PRs retain their separate review branches.

_Helmsman · not reported - not reported_

# Plugin implementation completion ledger

The active objective is to complete every phase in [the architecture plan](plugin-architecture-plan.md), including independent review, fixes, and behavioral verification. A completed increment is not completion of the full objective.

| Phase | State | Required evidence |
|---|---|---|
| A — Host foundation | Complete (`2e8d8ff`, `7c8c27e`) | Standalone SDK/distribution, isolated source-denied installation and route reload, archive/registry rejection, full safe start, existing browser flows. Build, unit, browser/visual, distribution gates passed. |
| B — External frontend and backend | Complete | Independent Costs and pricing packages use public SDK only; explicit reversible replacements; settings/storage survive restart; missing providers remain unavailable; measured usage and budgets survive disabling presentation/pricing; isolated production-server proof. Verified by 2,968 unit/integration tests, 10 browser/visual tests, six distribution checks, three isolated server tests, and build/TypeScript. |
| C — Persistence and recovery | Pending | Lifecycle/draining, dependency artifact/checkpoint pins, migration ownership/ledger, legacy fixtures, attachment handshake, durable operation outbox and remote uncertainty, safe upgrade/rollback under concurrent usage. |
| D — Task sources | Pending | Todos and Jira coexist; neutral logical identity and immutable admission bindings; explicit compatible source adoption; pinned operations survive replacement; two providers pass one contract suite. |
| E — Pages and integrations | Pending | Helm and every optional page/panel/integration use replaceable public contributions; layout/route state survives absence; scope, settings, polling and disposal behave correctly; execution exceptions explicitly await F. |
| F — Execution extensions | Pending | Agent/host/workflow/scheduling implementations launch, monitor, stop, recover and finalize through public APIs; alternate implementations pass contract tests; recorded bindings, publication/clarification gates, budgets and concurrency remain enforced. |
| G — Stabilization and removal | Pending | Independent author builds frontend/backend from public docs; proven versioned contracts; no optional feature/private host import exceptions; legacy switches removed; complete unit/integration/visual/distribution verification. |

Each phase must also satisfy the cross-cutting gates in architecture plan section 8. Pending or indirect evidence is not a passing gate. After implementation, review and fix findings before moving to dependent extraction; review each completed commit before pushing.

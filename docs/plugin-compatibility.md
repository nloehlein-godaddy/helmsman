# SDK compatibility and deprecation

The public SDK is stable at **1.5.0**, distributed in `sdk/` with Helmsman. It is not published to npm. Install that directory into an independent author project. The SDK package version is maintained in `sdk/version.json` independently of the application version.

| Version | Meaning and current support |
|---|---|
| Plugin `manifest.version` | Author-owned semantic package release. Changed bytes require a new release. |
| `packageVersion` | Archive descriptor format: 1. |
| `manifestVersion` | Presentation metadata: 1 for pages; 2 adds panels/compositions. Both remain supported. |
| `sdkVersion` | Exact host protocol major: 1. It is an integer, not an npm semver range. |
| SDK package version | Public TypeScript declarations and bundleable helpers: 1.5.0. Patch releases fix compatible behavior; minor releases add compatible optional APIs. |
| Capability/service/contract version | Independent protocol version, currently 1. Keep shared `helmsman/...` IDs when replacing implementations. |
| `storageVersion` | Namespaced backend storage schema: 1. It never authorizes changing a retained execution binding. |
| `node` range | Inclusive `minMajor`, exclusive `maxMajorExclusive`; checked at installation, enablement, startup and retained external recovery before module evaluation. |

Unsupported SDK, manifest, capability and storage versions are rejected before activation. An explicitly unavailable selection remains unavailable; it cannot silently select a different implementation. Declare required public services in presentation metadata and check optional services before using them. The browser SDK and `/node` entry are distinct; browser assets must not import Node helpers.

New optional methods/fields may be added within a contract version. Existing required fields, signatures, identifier semantics and failure/recovery behavior remain compatible. A breaking protocol change requires a new capability/service version and explicit host support. A breaking SDK lifecycle or helper change requires a new SDK major and compatible host protocol. Neither an application upgrade nor a new plugin package version implicitly changes these contracts.

Version 1.1 adds optional Bugs descriptions, feature-detected `services.taskContext`, and the bundleable loading wheel. Task context is optional only: do not add it to the v1 manifest's closed `requires` identifiers. Existing packages and protocol major 1 remain supported; the frozen 1.0 baseline remains the compatibility reference.

Version 1.2 adds optional `taskActions`, source `remoteActions` declarations and `prepareRemoteAction`. Assignment requires explicit `helmsman/task-action@1` frontend permission. Existing read-only permissions do not authorize it. Older sources remain readable without implementing assignment. Older hosts reject packages declaring the new permission or remote actions; install a host supporting SDK 1.2 before those packages. The frozen 1.0 baseline remains unchanged.

Version 1.3 adds optional notification clearing with a snapshot cutoff, live-instruction, execution-policy, feedback-command and feedback-settings services, feedback-tracker backend providers, and retained feedback-workflow policies. New presentation permissions must be declared explicitly; older hosts cannot run packages requiring those services. The application remains version 0.4.0 and the frozen 1.0 compatibility baseline is unchanged. See [live instructions](run-instructions.md), [product feedback](product-feedback.md), [execution settings](../src/plugins/execution-settings/README.md) and [workflow authoring](workflow-authoring.md).

Version 1.4 adds the optional `PluginPageModule.attention(context)` read hook. Existing page modules remain valid without it. The selected questions page can return bounded stable item keys through public services; core owns polling, scope/lifetime fences, tab presentation and sound. Declare the read service used by the hook on the page contribution. See [authored questions](authored-clarifications.md#question-tab-attention).

Version 1.5 adds optional retained `RunReadSummaryV1.title` presentation metadata. Older summaries remain valid; history uses the title when available without fetching additional PR details.

The optional failure post-mortem service adds the `helmsman/postmortem@1` presentation permission and the public `postmortem` service. Like live instructions, every call is bound to the run's repository and the current galleon scope. Declare the permission explicitly; older hosts reject packages requiring it. The run viewer requires it from 0.3.0. The application remains version 0.4.0 and the frozen 1.0 compatibility baseline is unchanged.

## Enforcement

`sdk/baseline/v1/` records the stabilized public declarations. `scripts/sdk-compatibility.mjs` checks every baseline export in both SDK entries, compiling assignments in both directions between baseline and candidate types with strict TypeScript settings. It rejects missing exports and incompatible structural signatures; optional additive members and new exports remain allowed. Generic public types are compared with shared type parameters, not erased to `any`. Unsupported constrained baseline generics fail closed and require an explicit compatibility fixture.

Communication manifests have one explicit input extension: `access` accepts `['provider-network']` alongside the existing `['browser-session']`. Network providers implement the optional `connectionIdentity()` method; browser providers remain unchanged. For candidate-to-baseline assignments only, the checker projects that exact access union back to `['browser-session']` at `CommunicationProviderDeclaration.access` and `PluginBackendDefinition.communications[*].access`. Baseline-to-candidate assignments remain strict and unprojected. All other fields, exports and access values retain the ordinary bidirectional checks. The frozen baseline is unchanged; regression fixtures reject removed browser access, arbitrary additional access modes and unrelated signature changes. This extension does not imply that an older host supports network communication packages.

Local Git adds the explicit `release-worktree` input with `path`, `expectedCommit` and `expectedBranch`. The checker projects only that exact arm out of candidate Local Git operations and their receipt/service/context return projections for candidate-to-baseline checks. Existing inputs remain strictly assignable to the candidate. Exported Local Git parser parameters are also projected to the old operation set when checking baseline parser assignability, while parser results retain the candidate return type. Unrelated operation, status and service changes still fail. Receipt recovery remains caller-scoped and never replays an unknown operation. Older packages that cannot interpret a retained release receipt must preserve it and block further operations until a compatible package handles it. Older hosts do not support this new action.

The `helmsman/task-action@1` manifest permission is one explicit input extension. Candidate-to-baseline checks project only that exact requirement ID out of `PluginServiceRequirementV1` and its page/panel/manifest/discovery/context projections. All older inputs remain assignable to the candidate; removed permissions, unrelated new IDs, changed versions and unrelated metadata changes still fail. This does not grant write authority to existing read-only packages.

Every distribution build runs this check against its freshly emitted SDK. Maintainers can also run:

```sh
node scripts/sdk-compatibility.mjs /absolute/path/to/candidate/sdk
node --test scripts/sdk-compatibility-check.mjs
```

The baseline is reviewed source, never automatically regenerated by a build or test. Do not update it to make an incompatible version-1 change pass. Compatible additions can extend the baseline in a reviewed SDK minor release. Keep earlier contracts usable; a deliberate major requires separate baseline and host support rather than overwriting v1.

This is a conservative structural gate, not proof of runtime semantics. TypeScript method variance, overload compatibility and structural equivalence have their normal TypeScript limitations. The check cannot establish authorization, ordering, persistence, cancellation or remote-effect behavior. Keep focused behavioral and independent installed-author checks for those boundaries. Bidirectional checks may reject a safe one-way type refinement; resolve that deliberately rather than silently relaxing the baseline.

## Deprecation and retained recovery

Retained agent, execution-host, native-terminal/browser and workflow loaders check the Node range of every external artifact in their captured closure before evaluating any provider code. Retention does not override runtime compatibility. Recovery stays blocked on an unsupported runtime; use the original supported runtime or an explicitly supported migration rather than substituting another artifact.

Deprecation must identify the replacement, migration instructions and removal criteria in public docs and declaration annotations. Deprecated contracts keep their behavior throughout the supported major. Removal requires a new major, explicit compatibility rejection, a documented migration, and evidence that supported retained work can still recover. No removal date is inferred from a phase being complete. Do not remove artifact pins, caller identities, journals or compatibility decoders merely because new admissions use a newer API.

`TodoLegacyRecoveryServiceV1` is deprecated **for new integrations**. New Todo mutations use `SourceCommandServiceV1`. The legacy service only enumerates, checks and acknowledges historical browser journals; never replay those commands through the replacement service. Keep it available while supported installations can contain such journals. Removal requires an explicit migration or preserved recovery path for every retained request, plus a future major release. Its continued recovery availability is intentional, not an active legacy mutation path.

Follow the [release-only quickstart](plugin-quickstart.md) for authoring and [package operations](plugin-packages.md) for disablement, retained versions and safe start.

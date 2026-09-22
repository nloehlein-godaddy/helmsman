# Docker execution

Build the runtime image, configure the shipped Docker host package, select it, and restart Helmsman:

```sh
docker build -t helmsman/moonunit-adoption:test -f docker/helmsman-runtime/Dockerfile .
helmsman plugins configure helmsman.host-docker '{"image":"helmsman/moonunit-adoption:test"}'
helmsman plugins select-execution-host helmsman.host-docker/docker
```

`RUN_HOST=docker` and `HELMSMAN_DOCKER_IMAGE` are one-time migration seeds. They initialize the execution-host selection and Docker package setting only when those records do not exist. Later environment changes do not override plugin configuration. Use `plugins configure` and `plugins select-execution-host` after migration.

The package resolves the configured image tag to Docker's immutable `sha256` image ID during admission. Each voyage retains the exact host provider artifact, effective package settings, and resolved image configuration. Launch, discovery, stop, recovery, and child stages continue through that retained provider after the selected default, package settings, or enabled state changes. A missing retained provider or unknown native ownership blocks recovery without falling back to local execution.

The image pins Node's base digest, Codex 0.155.1 and Claude Code 2.1.278. No host home directory, SSH material, Git credential configuration, Docker socket, or long-lived API token is mounted. Coding and PR review keep their supervisor on the host and run individual agent stages in containers. The supervisor preserves existing exact-revision review gates and performs publication. Container GitHub access is read-only. Merges remain human actions.

Each agent stage uses a standalone Git clone, a private runtime directory, and the pinned skills directory mounted read-only. Review workspaces are read-only, with separate output files. The host verifies bounded regular output files, records immutable artifacts, and replaces guest Git configuration before invoking host Git. Each stage has an internal Docker network and a gateway relay. The relay forwards only to the authenticated host gateway; agent containers cannot connect directly to host services or the internet. Network and container identities carry the run ID for cleanup.

Configure the GoCaaS settings described in [model routing](model-routing.md) on the host. The gateway defaults to port 8790 (`HELMSMAN_GATEWAY_PORT`); access requires a random per-run capability, stored as a hash in SQLite, valid only while that run is active. Capabilities expire within 24 hours and are revoked when the run completes. GoCaaS credentials stay in the host process and are never passed to stages. Codex uses its documented custom-provider configuration inside a fresh private `CODEX_HOME`; host authentication/configuration is not copied. Provider prices are never inferred.

Clarification files inside a stage use private `/runtime` paths. The host relay appends questions to the retained execution attempt's channel and copies only that channel's answers back into the stage. The host supervisor performs the attempt-fenced publication check. A per-run gateway capability does not authorize a stale attempt to pass the clarification gate: new channels also require the exact attempt number and channel ID. Legacy questions with unknown provenance remain unresolved publication obligations; see [clarification recovery](recovery.md#clarification-channels-and-unresolved-questions).

Dependency installation cannot use unrestricted internet access. Provision the required dependency cache in the runtime image; private registries require an explicitly scoped future bridge.

Docker PR branch-update reruns currently fail preflight with an actionable instruction to use the trusted local host. Coding and standalone PR review are supported; local execution remains the default. Missing images, provider credentials, or required skills produce preflight errors rather than fallback to an unisolated host. No remote control channel is introduced: detached supervisors and Docker identities use the existing durable recovery protocol.

Validation: built the runtime image; exercised actual Docker launch, host-visible logs/exit code and liveness; exercised provider gateway behavior against fake upstreams without paid API calls. An actual provider-backed isolated coding/review run requires host API keys, which are not configured in this development session.

References: [Codex advanced configuration](https://developers.openai.com/codex/config-advanced/) and [configuration reference](https://developers.openai.com/codex/config-reference/), retrieved 18 September 2026.

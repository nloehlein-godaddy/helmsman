# Adversarial Security Review — Server Security & Authority

- **Reviewer area:** server request parsing/router, origin/CSRF/loopback exposure, authorization/scope, credential redaction, capability gateway/worker tokens, filesystem/traversal, download/log edges, safe-start/recovery boundaries, Docker/publication boundaries.
- **HEAD reviewed:** `ec3dd6b544cba1f796c353134dc4af0437cf40a8`
- **Baseline for A–G diff:** `e471d86630d78f2285611e81256ff912e5f57d0e`
- **Worktree:** `/private/tmp/helmsman-adversarial-20260921-ec3dd6b/claude_security`

## Trust model (as inferred)

The Helmsman server binds the main API to `127.0.0.1:${HELMSMAN_PORT ?? 8787}` (`server/helmsman/application.ts:1668`, `server/helmsman/main.ts:15`). It has **no authentication, no session, and no CSRF token**. The only defense against a malicious web page in the developer's browser reaching the loopback API is a *same-origin + `Content-Type: application/json`* guard applied per-route in the HTTP dispatcher. Installed plugins/agents are explicitly trusted (documented arbitrary code execution). The scoped gateway proxies real OpenAI/Anthropic/GitHub credentials to isolated (Docker) workers, gated by high-entropy per-run capability tokens.

---

## FINDING 1 — Cross-site request forgery reaches state-changing routes, including two agent-launch (RCE-class) paths — **HIGH**, reproduced

### Location
- Dispatcher guard: `server/helmsman/application.ts:1570-1574`
- Body parser (accepts any content-type): `server/helmsman/application.ts:1453-1461`
- Unguarded launch handler: `server/helmsman/router.ts:372-421` (`POST /api/agents/launch`)
- Unguarded source launch: `server/helmsman/task-source-routes.ts:96-102` (`POST /api/task-sources/:id/launch`)
- Other unguarded mutators: `server/helmsman/router.ts:327-341` (resume), `342-371` (retry), `422-425` (stop), `426-432` (auto-claim), `255-283` (`POST /api/todos`)

### The gap
The CSRF/same-origin guard is applied only to an explicit route-prefix allowlist:

```js
// application.ts:1570
if ((url.pathname.startsWith('/api/run-commands') || ... || url.pathname.startsWith('/api/source-admin'))
    && req.method === 'POST'
    && (req.headers['content-type']?.split(';')[0] !== 'application/json'
        || req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
  res.writeHead(403, ...); return;
}
```

The list omits `/api/agents`, `/api/task-sources`, `/api/todos`, and `/api/repos/*/auto-claim`. Those routes fall straight through to `handleApi` (line 1581), where the body was already parsed by `readBody`, which calls `JSON.parse` **regardless of `Content-Type`** (`application.ts:1457`). `handleApi` performs **no** origin check.

Because the body parser ignores `Content-Type`, an attacker page can issue a CORS **"simple" request** (`Content-Type: text/plain`, no custom headers) — which browsers send cross-origin **without a preflight** and without any CORS opt-in from the server. The attacker cannot read the response (blocked by CORS), but the **side effect executes**. `POST` is a simple-request method; `PUT`/`DELETE` are preflighted (and the server returns no CORS headers), so `PUT /api/config`, `PUT/DELETE /api/todos/:id`, and `PUT .../assessment` are effectively protected by the missing-preflight-response — **but every `POST` mutator above is not.**

### Impact
Any website the developer visits while Helmsman is running can silently:
- **Launch an AI-agent voyage with an attacker-chosen freeform task** (`mode:'freeform'`, arbitrary `repo` + `task`) — `router.ts:411-414`. The freeform path enforces only `canStart(repo)`, which checks **concurrency only** (`process-manager.ts:30-37`) — no galleon allowlist and no `isGithubRepo` check on `repo`. The launched agent executes the attacker's instructions with the developer's tools/filesystem access ⇒ effectively remote code execution on the developer's machine.
- Launch a source voyage via `POST /api/task-sources/:id/launch` (`task-source-routes.ts:96`).
- Stop / retry / resume any run, toggle `auto-claim` for arbitrary repo strings, and create local todos.

### Reproduction (guard-gap proven executably)
`probes/claude_security/csrf-probe.mjs` replicates the exact dispatcher guard (`application.ts:1570-1574`) and `readBody` (`1453-1461`) verbatim, then fires cross-origin (`Origin: http://evil.example.com`) `text/plain` requests:

```
$ node probes/claude_security/csrf-probe.mjs
POST /api/agents/launch : {"status":200,"body":"{\"launched\":true,\"body\":{...\"task\":\"rm -rf ~ (attacker)\"...}}"}
PUT  /api/config        : {"status":200,...}          # note: real PUT would be preflighted
POST /api/run-commands/x: {"status":403,"body":"{\"error\":\"blocked\"}"}   # guarded route rejects
reached state-changing handlers: ["/api/agents/launch","/api/config"]
```

The guarded command route is blocked; `/api/agents/launch` is reached with the attacker body. Real-world attacker page:
```html
<script>fetch('http://127.0.0.1:8787/api/agents/launch',{method:'POST',
  headers:{'Content-Type':'text/plain'},
  body:JSON.stringify({mode:'freeform',repo:'my-org/my-repo',task:'<attacker instructions>'})});</script>
```

### Provenance
Baseline (`e471d86:server/helmsman/main.ts:666-705`) had **no** origin/CSRF guard on any route. The A–G rewrite introduced the same-origin guard but only for the new versioned command routes, leaving inherited legacy mutators (`/api/agents/*`, `/api/todos`) and new `/api/task-sources/*` mutators unprotected. This is a partial fix that creates a false sense of coverage.

### Minimal fix direction
Enforce the guard globally for all mutating methods rather than an allowlist: apply the `Content-Type: application/json` + same-origin check to every `POST`/`PUT`/`DELETE`/`PATCH` before dispatch (default-deny), with an explicit allowlist only for genuinely cross-origin intake (`/api/webhooks/github`, which already validates its own signature). Requiring `application/json` alone (which forces a preflight cross-origin) closes the simple-request vector even where `Origin` is absent.

---

## Secondary observations / improvements

1. **Scoped gateway binds `0.0.0.0` in Docker mode** — `server/helmsman/gateway-listener.ts:25`. When an isolated (Docker) host is selected, the credential-proxying gateway listens on all interfaces (default port 8790) so `host.docker.internal` can reach it. It is token-gated (`scoped-gateway.ts:56-58`, sha256 of 32-byte random token, TTL + `active(runId)` checks), so this is not directly exploitable, but it exposes a credential-bearing proxy to the LAN. Consider binding to the Docker bridge/`host-gateway` address rather than `0.0.0.0`, or firewalling the port. Static-only observation.

2. **`POST /api/agents/:id/stop` does not validate the run-id** — `router.ts:422-424` passes `stopMatch[1]` straight to `deps.stop`, unlike sibling routes (`resume`/`retry` at `330`/`345` validate `^[a-z\d_-]{1,128}$`). Harmless today (map lookup), but inconsistent; add the same validation.

3. **Freeform launch accepts an unvalidated `repo`** — `router.ts:397,411-414`. Unlike `mode:'source'` (`isGithubRepo` at line 375) and the retry allowlist check (`350-352`), freeform performs no `isGithubRepo`/allowlist validation. Independent of Finding 1, launches should verify the repo against configured galleons before accepting attacker-supplied repo strings.

---

## Tested negatives (attempted and could not exploit)

- **Static file traversal** (`application.ts:1643-1651`): `normalize(join(DIST, rel))` + `file.startsWith(DIST + sep)` guard. Probe `/tmp/trav.mjs` shows `/../../etc/passwd`, `%2e%2e`, `..%2f`, and `foo/../../../etc/passwd` all resolve outside DIST and are rejected (`ALLOWED:false`); `/....//` stays inside DIST (literal dir name). Robust.
- **Plugin asset serving** (`server/helmsman/plugins/http.ts:29-37`): served from an in-memory `artifact.files` map keyed by exact path, gated by `isPluginAssetPath`; backslash/rewrite variants 404 (`:18`). No filesystem read, no traversal. `.html` is not in the MIME map ⇒ served `application/octet-stream` + `nosniff`, so no reflected-HTML rendering.
- **Run log download / SSE** (`server/helmsman/run-log.ts`): `text/plain; charset=utf-8` + `nosniff` + `attachment` for download; SSE payloads are `JSON.stringify`-escaped (`:12-13`); back-pressure cap at 2 MB (`:78`). No XSS/unbounded-buffer path found.
- **Run-inspect export** (`server/helmsman/run-inspect-export.ts:17`): `Content-Disposition` filename is `helmsman-${runId}.log` with `runId` constrained to `[a-z\d_-]{1,128}` (`:8`, `run-inspect-service.ts:106`) — no header injection/response splitting; `contentType` is fixed.
- **Config read/write redaction**: `GET /api/config` uses `publicConfig` (`config-store.ts:27-40`, no tokens/secrets) and additionally strips `JIRA_/GITHUB_/SLACK_/PRE_PR_/HELMSMAN_WEBHOOK_` (`application.ts:1622-1625`); `setOverride` rejects `SECRET_KEYS`/non-`EDITABLE_KEYS` (`config-store.ts:63-65`) and the router blocks those prefixes with `410` (`router.ts:445-449`). No secret disclosure/write path found.
- **Cross-origin info disclosure via GET**: server sets no CORS headers, so CSRF cannot read any GET response body; the exposure is limited to state-change side effects (Finding 1).
- **Webhook credential PUT** (`application.ts:1521-1539`): has its own same-origin + `application/json` guard and single-key body validation.

## Inspected areas
`application.ts` (full HTTP dispatcher, `launch`, gateway wiring), `router.ts` (entire surface), `main.ts`, `safe-start.ts` (skimmed — reuses `handlePluginRequest`), `scoped-gateway.ts`, `gateway-listener.ts`, `plugins/http.ts`, `run-log.ts`, `run-inspect-export.ts`, `task-source-routes.ts`, `config-store.ts`, `process-manager.ts`; baseline `main.ts` for provenance.

## Tests run
- `probes/claude_security/csrf-probe.mjs` — **demonstrates guard gap** (launch reached, command route blocked). PASS (confirms vuln).
- `/tmp/trav.mjs` — static traversal guard — all escapes rejected. PASS (negative confirmed).
- Did not run app/distribution builds or full suites per instructions; probes are isolated temp servers on `127.0.0.1:18787`, no live user server contacted.

## Limitations
- Finding 1's downstream RCE severity depends on the launched agent/workflow actually executing the freeform `task` against a reachable workspace; I verified the request reaches `launch` with attacker-controlled `repo`/`task` and that `canStart` imposes no allowlist, but did not execute a full agent run (would require live agent/Docker, out of scope). The CSRF reachability itself is proven.
- CORS "simple request" behavior (browser sends cross-origin `POST text/plain` without preflight, attaches `Origin`, blocks response read) is established web-platform behavior, asserted rather than driven through a real browser here.
- Did not exhaustively fuzz every command-route body validator (owned by adjacent reviewers); focus was the authority/edge boundary.

_Helmsman · claude-opus-4-8 - high_

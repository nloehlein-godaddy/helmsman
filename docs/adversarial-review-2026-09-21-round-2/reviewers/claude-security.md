# Adversarial security review — HTTP / authority lane

**Scope:** Central mutation guard and dev proxy end-to-end, safe/read methods, webhook exact exemption + HMAC, malformed authority/Origin/fetch-metadata, request parsing/limits, public/private routing, credential redaction, worker gateways + publication tokens, resource/download/file boundaries (path traversal/symlink/TOCTOU), shell/command injection, startup/safe-start/recovery boundaries. Mandate: **challenge R02 completely** and establish the real reachable threat model.

- Audited HEAD: `e3ccca4d6b31db70974f4c8e70784e491768d9c8`
- Prior review head: `ec3dd6b`; baseline `e471d86`
- R02 fix commit: `8dcdb6a`
- Environment: macOS arm64, Node v24.17.0, shared read-only symlinked `node_modules`.

## Bottom line

**No new confirmed exploitable security defect found in this lane. R02 is genuinely fixed and holds under adversarial and socket-level testing.** The webhook HMAC path, scoped gateway/publication tokens, safe-start read-only boundary, artifact/file boundaries, and command construction are all sound. Findings below are hardening/hygiene (low), not defects. All primary claims are execution-proven against disposable servers / the actual `allowMutationRequest` source.

---

## R02 — challenged completely, verified fixed (execution-proven)

**Guard:** `server/helmsman/request-origin.ts:3` `allowMutationRequest`, invoked as the first statement of the request handler at `server/helmsman/application.ts:1513`, before any routing or body read. Default-deny for every non-`GET`/`HEAD`/`OPTIONS` method; single exact exemption `POST /api/webhooks/github`.

The guard requires, for any mutating method:
1. `Content-Type` (param-stripped, trimmed, lowercased) exactly `application/json` — `request-origin.ts:6`.
2. `Sec-Fetch-Site !== 'cross-site'` — `:7`.
3. `Host` present and, parsed as a URL authority, hostname ∈ {`localhost`,`127.0.0.1`,`[::1]`}, no userinfo/path/query/fragment — `:9-11`.
4. `Origin` absent **or** exactly equal to `http://<Host>` — `:12`.

### Why the original exploit is dead
The original R02 used a cross-origin `no-cors`, `Content-Type: text/plain` POST to `/api/repos/…/auto-claim`. A browser `no-cors` request can only carry `text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data`; `application/json` is **not** CORS-safelisted, so any cross-origin JSON POST forces a preflight. **The server emits no `Access-Control-*` headers anywhere** (verified: `Grep "Access-Control" → no files`), so every preflight fails and the real request never leaves the browser. Independently, the `Origin`/`Host` equality check rejects a foreign origin. Two independent layers.

### DNS rebinding
Blocked by the Host allowlist: a rebind of `evil.com → 127.0.0.1` still sends `Host: evil.com:PORT`, whose hostname is not in the allowlist → 403. Proven.

### Adversarial matrix — pure guard (`probes/claude_security/guard-probe.ts`, **29/29**)
Negative controls (legit same-origin JSON, CLI no-Origin, GET/HEAD/OPTIONS, exact webhook) all `true`. Attacks all `false`: text/plain & no-content-type & form & multipart cross-origin POST; JSON with foreign Origin; `Sec-Fetch-Site: cross-site`; `application/json-patch+json` (not exact); Host `evil.com` / path-smuggle / embedded creds / `0.0.0.0` / missing; Origin port-mismatch and scheme-mismatch; webhook credential PUT cross-origin; `/api/webhooks/github/credential` and `/api/webhooks/github/` (trailing slash) **not** treated as the exact exempt path. Dev-proxy same-origin (`localhost:5173`) allowed.

### Socket-level end-to-end (`probes/claude_security/guard-http-probe.ts`, **8/8**)
Against a disposable `http.createServer` replicating the exact dispatch order (guard → fake `auto-claim` mutation):
- text/plain cross-origin POST → **403**, mutation counter stayed 0.
- **Duplicate `Content-Type` header smuggling** (`text/plain` + `application/json`) → **403**, mutation not executed (Node collapses duplicate content-type; guard sees non-JSON).
- `OPTIONS` preflight with `Origin: evil.com` → 404 with **no `Access-Control-Allow-Origin`** → browser would block the follow-up.
- Legit same-origin JSON POST → 200, mutation executed **exactly once**.
- **Absolute-form** request target `POST http://evil.com/…` with `Host: evil.com` → **403** (Host governs).

**Conclusion:** R02 fix is complete and robust. Reproduction: `tsx probes/claude_security/guard-probe.ts` and `tsx probes/claude_security/guard-http-probe.ts` (both exit 0).

---

## Threat model established

- The server binds `127.0.0.1:PORT` (`application.ts:1663`); it has **no cookie/session auth** — authority rests entirely on loopback binding + the origin/JSON guard. Consequently CSRF has no ambient credential to ride; the only browser vector is a cooperating same-machine origin, now defeated by the JSON-content-type requirement (no CORS approval) and the Origin/Host check.
- The **only** unauthenticated cross-origin-reachable mutation is `POST /api/webhooks/github`, gated by HMAC-SHA256 (below).
- Cross-origin **reads** cannot be exfiltrated: no `Access-Control-*` headers, so responses stay opaque.
- Worker gateways (`0.0.0.0` under Docker) require 256-bit capability tokens; network exposure without a token is inert.
- Trusted plugin/agent code and the local dev Vite proxy are inside the trust boundary by design.

## Webhook exact exemption + HMAC — verified sound
`webhooks.ts:91 receiveTriggered`: signature verified with `timingSafeEqual(HMAC-SHA256(secret, raw), …)` **before** any `JSON.parse` of the payload (`:100`, parse at `:110`); digest must match `/^[a-f\d]{64}$/i` (32 bytes) so `timingSafeEqual` never throws on length. Raw body capped at 1 MB (`application.ts:1547`, re-checked `webhooks.ts:95`). Delivery-ID replay + payload-digest mismatch handled (`:103-107`). `/api/webhooks/github` is matched by exact string equality (`application.ts:1544`, guard `request-origin.ts:5`), so `/credential` (PUT) and trailing-slash variants correctly fall through to the full guard. **No unauthenticated launch is reachable without a valid signature.**

Minor (low): `assertEnabled()` runs before signature verification (`webhooks.ts:92` vs `:100`), so an unauthenticated POST performs a cheap trigger-capture DB read before the 401. Negligible amplification; note only.

## Scoped gateway / publication tokens — sound
`scoped-gateway.ts`: capabilities are `randomBytes(32)` hex, stored hashed (sha256), validated `/^[a-f\d]{64}$/` + `expiresAt` + `active(runId)` (`:56-58`). GitHub read proxy blocks traversal (`%`,`\`,`..`,`#`) and pins to `/github/repos/<scope.repo>/…` with a strict route allow-regex (`:113`); `redirect: 'error'` blocks SSRF-via-redirect (`:122`). Publication requires non-readonly scope, `clarificationReady`, matching branch/repo, and a live publication capability (`:59-74`). `git/push` validates `headSha` as 40/64 hex and rejects extra keys (`:85-86`). Anthropic beta header strictly validated (`:104`). `publication-service.ts` fences every `gh`/`git` call with `assertCurrent`, arg-arrays (no shell), `--body-file` for untrusted PR bodies, and `execFile` — no injection surface. All subprocess use across `server/` is `execFile`/`exec` (arg arrays); **no `shell:true` / `execSync` interpolation in production** (verified).

## Safe-start / recovery boundary — sound (R08 verified)
`safe-start.ts:119-121`: any non-GET/HEAD → 503; provider execution disabled. **R08 fix present:** slot validation now uses `isBuiltinPageSlot` for all page slots (`:75`), not Costs-only. Static file serving is traversal- and symlink-safe: `resolve` + `startsWith(base+sep)` + **`realpath` recheck** before read (`:180-186`).

## File / download / artifact boundaries — sound
`artifacts.ts`: strict `SAFE_ID` on runId/stage/reviewer, path-escape check via `relative(root, …)`, `lstat` symlink rejection, `open('wx')` exclusive writes, content/hash verification (`:39-142`). `run-inspect-export.ts` gates on `[a-z\d_-]{1,128}` runId, GET-only. Main-app static serving (`application.ts:1640-1641`) is `normalize` + `startsWith(DIST+sep)` guarded.

## Reliability check — no regression from the new guard
Every frontend/plugin mutation client sets `Content-Type: application/json`: `todoClient.ts:82,99` (DELETE header added in `8dcdb6a` — the reason that file changed), `agents.ts`, `config.ts`, `outcomeClient.ts`, `taskSources.ts`, `clarificationClient.ts`, and all command services via the shared `clarification-transport.ts:47-48` (`credentials: 'same-origin'` + JSON). Verified no mutating client omits the header, so the default-deny guard does not break legitimate flows.

---

## Hardening / hygiene ideas (not defects)

| Item | Location | Note |
|---|---|---|
| Safe methods with side effects | `application.ts:1518` (catalog `reconcile`+`refreshPluginSnapshot`); `router.ts:218` (`timeoutDue`+`cleanupOrphans` on `GET /api/clarifications`) | Cross-origin-triggerable, but idempotent time/state-derived maintenance any legitimate poll also runs; attacker gains no controlled state change and cannot read the opaque response. Prefer moving maintenance off GET or gating behind the mutation guard for defense-in-depth. |
| Static symlink parity | `application.ts:1640` | Unlike safe-start, the main app omits a `realpath` recheck. Not remotely exploitable (DIST is trusted build output, not attacker-writable); add for parity. |
| Webhook pre-auth work | `webhooks.ts:92` | Run signature verification before `assertEnabled()`. |
| Dev-proxy smuggling | `vite.config.ts` | Vite/Node desync is a theoretical dev-only concern; outside the production threat model (prod has no upstream proxy). |

## Negative controls
- Legit same-origin JSON POST allowed and executes exactly once (both probes).
- CLI/non-browser no-Origin JSON POST allowed (intended).
- Webhook exact path allowed through guard; credential PUT and trailing-slash variants correctly rejected.
- Duplicate-content-type and absolute-form authority attacks proven blocked at the socket.

## Areas inspected
`request-origin.ts`, `application.ts` (dispatch, `readBody`/`readRawBody`, static serving, webhook routes), `webhooks.ts`, `router.ts`, `scoped-gateway.ts`, `gateway-listener.ts`, `docker-gateway-relay.mjs`, `publication-service.ts`, `artifacts.ts`, `run-inspect-export.ts`, `safe-start.ts`, `vite.config.ts`, and the frontend/plugin mutation clients + `clarification-transport.ts`.

## Tests executed
- `tsx probes/claude_security/guard-probe.ts` → 29/29 pass.
- `tsx probes/claude_security/guard-http-probe.ts` → 8/8 pass, exactly one legitimate mutation.
- Static verification greps (no `Access-Control-*`, no `shell:true`/`execSync` in production, content-type presence across clients).

## Gaps / not covered
- No full app/distribution boot or real Chromium run in this lane (root/UI own that); browser-layer preflight-blocking is inferred from the proven absence of CORS headers + `no-cors` content-type constraints, not re-run in a live browser here.
- No HTTP/2, TLS, or Windows path behavior exercised.
- Deep concurrency/race testing of the publication operation ledger and webhook `scan()` claim loop was not exhaustively fuzzed (belongs to execution lane); reviewed statically and found consistent with capability/`assertCurrent` fencing.
- Did not re-verify R01/R03–R07/R09–R12 (other lanes); only R02 and adjacent R08 boundary within my area.

_Helmsman · claude-opus-4-8 - high_

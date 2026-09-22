# Model routing

Managed agent model traffic goes through the run-scoped Helmsman gateway and then GoCaaS. Local and Docker stages use the same gateway contract; no stage receives the host GoCaaS credential. The host resolves credentials only when inference begins.

The default upstream is `https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1`. Set `GOCAAS_BASE_URL` only to an approved GoCaaS HTTPS host (production, test and dev onkatana hosts or corresponding `api.gocode.caas.*gdcorp.tools` hosts). A root host is normalized to `/v1`; query strings, fragments, credentials and other paths are rejected.

API-key mode is the default. Set `GOCAAS_API_KEY` or provide an executable helper with `GOCAAS_API_KEY_HELPER` (default: `~/.gocode/bin/gocode`); Helmsman invokes it as `api-key-helper`, with bounded output and a short timeout. Helper availability is checked during admission, but the helper is not invoked until inference. `GOCAAS_AUTH_MODE=sso-jwt` is available only when the operator supplies a JWT through the configured credential source; Helmsman does not mint S2S tokens.

OpenAI Responses and Anthropic Messages use the GoCaaS `/v1` base. API-key mode sends Bearer for Responses and `x-api-key` for Anthropic. S2S mode sends `Authorization: sso-jwt` for both. Supported agent metadata transports remain `openai-responses`, `anthropic-messages`, and `null`; an unsupported or undeclared custom command transport is rejected at admission. There is no direct vendor fallback.

The local host remains a trusted process with its existing permissions. The gateway and Docker relay scope model requests to an active run; this does not make local plugins a network sandbox. Existing processes keep their retained runtime configuration; changing settings applies to new admissions and may require restart or retained-runtime recovery rules.

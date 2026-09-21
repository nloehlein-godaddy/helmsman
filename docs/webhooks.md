# Workflow webhooks

Webhook trigger extraction is reviewed and pushed through `12a62c9`. The selected `github-webhook` trigger owns event/action parsing and route policy; core owns authentication, credentials, durable delivery identity and guarded dispatch. New intake requires this selected parser; removing it never enables the retired core parser.

## Configure the selected parser

For the shipped parser, configure nonsecret routes and enable the package policy:

```sh
helmsman plugins select-trigger github-webhook helmsman.trigger-github-webhook/github
helmsman plugins configure helmsman.trigger-github-webhook '{"enabled":true,"routesJson":"[{\"repo\":\"owner/project\",\"event\":\"issues\",\"action\":\"opened\",\"workflowRef\":\"coding@1\"}]"}'
```

Follow the CLI restart instruction. PR mappings use `review@1`; issue mappings use `coding@1`. Use `select-trigger github-webhook disabled` to disable the selection or `default` to restore its shipped provider. Explicit unavailable selections do not fall back. An unconfigured installation keeps intake disabled.

`HELMSMAN_WEBHOOK_ROUTES` initializes route settings once; changing it later does not overwrite plugin settings. `HELMSMAN_WEBHOOK_SECRET` similarly initializes a core credential slot once. Rotate or clear that slot through `PUT /api/webhooks/github/credential` with JSON `{ "secret": "replacement-value" }`. An empty string clears the credential and disables authenticated intake. Never put the secret in `routesJson`, other plugin configuration, URLs or browser persistence.

## Delivery and recovery

GitHub sends POST requests to `/api/webhooks/github` with `X-Hub-Signature-256`, `X-GitHub-Delivery` and `X-GitHub-Event`. Core verifies the HMAC over the exact raw body before consulting duplicate state, rejects oversized or invalid requests, and passes only the delivery ID, event and parsed JSON to the selected parser. The parser validates configured event/action mappings and returns one normalized intent or an ignored result. Payloads cannot choose another destination or workflow outside policy.

Accepted and deliberately ignored authenticated events persist with their body digest and captured parser provenance. Reusing a delivery ID with different bytes returns 409. A duplicate cannot become a new launch after route or parser changes, including an originally ignored event. The durable normalized proposal is dispatched without rerunning current parser policy.

Core rechecks configured galleons, source/workflow authority and capacity. Existing one-writer-per-galleon and publication gates remain enforced. Dependency pins retain the captured closure until terminal rejection or verified admission handoff; uncertain launch outcomes keep the original run ID and claim. Disabled policies stop new admissions while existing-run receipts and reconciliation continue. Older deliveries without trigger provenance remain explicitly legacy and retain their saved normalized payloads and identities.

The server binds loopback. Public ingress is separately configured by the operator. See [trigger authoring](trigger-authoring.md) and [plugin operations](plugin-packages.md#trigger-selection-and-settings).

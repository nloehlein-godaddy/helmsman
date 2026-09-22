# Firefox native browser

Firefox is an optional browser provider. Default Slack integration uses the [Slack Companion provider](../slack-companion/README.md) and does not require this bridge.

This backend-only package registers `helmsman.native-firefox/firefox` through `helmsman/native-terminal@1`. It exposes structured browser primitives for Firefox WebDriver BiDi and explicitly reports terminal screen/input methods as unsupported.

Set `bidiEndpoint` to the exact `webSocketUrl` returned when an operator creates a disposable Firefox WebDriver session. It accepts only a credential-free loopback `ws:` URL. Its default is empty, so activation stays offline and browser discovery reports unavailable until configured. The package opens and closes only its own BiDi socket: it never creates or deletes the external WebDriver session, starts Firefox, or attaches to a user profile. A lost pointer-action acknowledgement is uncertain and is never replayed.

Create a disposable headless session on unused ports (omit `-headless` for a visible disposable browser):

```sh
bridge_root=$(mktemp -d)
session_json=$(mktemp)
geckodriver --port 4445 --websocket-port 9233 --profile-root "$bridge_root" &
bridge_pid=$!
curl --fail-with-body -sS http://127.0.0.1:4445/session \
  -H 'content-type: application/json' \
  --data '{"capabilities":{"alwaysMatch":{"browserName":"firefox","webSocketUrl":true,"moz:firefoxOptions":{"args":["-headless"]}}}}' > "$session_json"
```

Capture the exact returned session URL, then configure and select the package:

```sh
bidi_settings=$(node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1])).value; console.log(JSON.stringify({ bidiEndpoint: v.capabilities.webSocketUrl }))' "$session_json")
session_id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).value.sessionId)' "$session_json")
helmsman plugins configure helmsman.native-firefox "$bidi_settings"
helmsman plugins select-browser-host helmsman.native-firefox/firefox
```

Keep the session creator running. A browser restart creates a different session and URL. New work uses an explicit settings revision; retained work stays pinned to its old endpoint and must reconcile or recover when it disappears. Do not configure a mutable current-session proxy. The operator owns cleanup:

```sh
curl --fail-with-body -sS -X DELETE "http://127.0.0.1:4445/session/$session_id"
kill "$bridge_pid"
wait "$bridge_pid"
```

Build with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript. A third-party copy must use a nonreserved package identifier.

# Live run instructions

The Run viewer can send a bounded instruction to an active local agent whose retained provider implements `buildInteractiveCommand`. Codex app-server and Claude stream JSON are supported. Isolated executions and older providers remain unavailable; starting a new run captures the current provider capability.

The panel declares `helmsman/run-instructions@1` and uses the optional public `runInstructions` service. Target reads return only the current run attempt, channel identity, and active agent labels. Sending captures that exact attempt, channel and target. Changing the header or panel scope cancels observations and hides requests outside that scope.

A caller-owned browser journal saves one request identity before delivery. The server persists the immutable command and an independent delivery identity before contacting the worker. Retrying a saved request reconciles it; it does not send a second instruction after possible delivery. Receipts are `sending`, `delivered`, `failed`, `unknown`, or `rejected`. Only the provider protocol acknowledgment proves delivery. A lost connection can leave an unknown receipt that later resolves from the retained worker evidence, including after the run finishes.

The worker endpoint is a private Unix socket with a run/attempt/channel fence. Its journal is separate from the server receipt and is never exposed as a public filesystem route. A stale target cannot redirect a command to a new attempt. Completed, failed or rejected receipts can be dismissed to send another instruction; unresolved receipts remain available for checking. The selected provider and workflow still own the command, model settings and prompt; core manages transport and the scoped model gateway.

See [agent authoring](agent-authoring.md) for the optional provider contract.

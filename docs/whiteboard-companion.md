# Whiteboard companion

The run viewer and PR panel expose an optional **Explain in Whiteboard** action. The companion creates a local, code-linked explanation for the exact selected PR base/head and, for runs, the selected attempt. It does not publish reviews or alter their verdicts.

Install Whiteboard separately (the prototype was verified with `@dev.fast/whiteboard@0.2.3`, requiring Node 24). Configure the Helmsman server environment:

```sh
HELMSMAN_WHITEBOARD_CMD=/absolute/path/to/whiteboard
HELMSMAN_WHITEBOARD_HOME=/absolute/path/to/local/whiteboard-state
HELMSMAN_WHITEBOARD_MODEL=gpt-6.1-sol
```

The executable receives fixed arguments without a shell. Its environment excludes Helmsman credentials and sets `DO_NOT_TRACK=1`. The companion uses the existing GoCaaS connection for one bounded, tool-free structured explanation request. Patch previews are limited to 32 KiB across changed files. Selected code evidence therefore goes to that configured model service. Token usage is stored in the local `whiteboard_usage` ledger and, for run targets, in the run usage view. Whiteboard sessions stay local; no sharing or agent trace capture is requested.

Start Whiteboard Desktop against the same state directory to use **Open in Whiteboard**. A headless local server can create and retain explanations, but cannot display the desktop canvas. The canvas is not embedded in Helmsman.

Repeated requests reuse the retained target/session. A failed content write retries the retained document against the same session. If external creation is interrupted before Helmsman receives its session ID, the target requires reconciliation; it will not automatically create another board. Inspect the local Whiteboard sessions and Helmsman's `whiteboard_sessions` record before recovering that target. After restart, a pending write with a retained session can retry against that board; an uncertain creation still requires reconciliation.

A moved PR comparison or run attempt is rejected. Select the current comparison to create its own explanation. Source evidence may be partial when the PR inspector truncates a large diff; the explanation must identify that limitation. Generated explanations supplement code review and may contain errors.

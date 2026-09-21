# Local execution hosts

This backend-only package registers `helmsman.host-local/detached`, `helmsman.host-local/cmux`, and `helmsman.host-local/wezterm` through `helmsman/execution-host@1`. Each provider retains the exact launch attempt, wrapper receipt, process identity, and native terminal reference. Missing or conflicting ownership evidence is reported as unknown and is never replaced by another provider.

The package settings `cmuxSocketPath`, `weztermBin`, and `weztermRunWorkspace` are captured with the retained provider binding. Build with `npm run build` after installing the released `@helmsman/plugin-sdk`, TypeScript and `@types/node`.

Local execution uses POSIX process groups on macOS and Linux. The wrapper starts a dedicated supervisor group for the worker and its ordinary descendants; cmux and WezTerm terminal groups are never signalled. Stop verifies the retained wrapper PID and process-start identity, then asks the supervisor to terminate its own group. A five-second grace period is followed by forced termination. Natural worker exit also cleans remaining background descendants. The wrapper publishes its terminal receipt only after the group contains no live processes; unreaped zombies cannot continue execution.

```mermaid
flowchart TD
    Receipt[Persist exact wrapper ownership receipt] --> Supervisor[Launch dedicated supervisor process group]
    Supervisor --> Worker[Run worker and ordinary descendants]
    Stop[Verify retained wrapper identity and request Stop] --> Terminate[Supervisor signals its own group]
    Terminate --> Grace[Escalate after five seconds if necessary]
    Worker -->|Main worker exits| Cleanup[Supervisor kills remaining group members]
    Grace --> Cleanup
    Cleanup --> Verify{No live group members?}
    Verify -->|Yes| Exit[Publish terminal receipt]
    Verify -->|No or inspection unavailable| Wait[Keep wrapper alive and withhold terminal receipt]
    Wait --> Verify
```

A crashed supervisor does not establish completion: the wrapper waits for any surviving group members before writing a failed outcome. A crashed wrapper disconnects the supervisor's ownership channel and triggers group cleanup, but cannot write a terminal receipt; recovery remains unknown until supported evidence is available. This containment covers ordinary inherited process groups, not deliberately daemonized descendants that escape into new sessions. Staged pre-PR workers retain their own additional stage-group cleanup.

Windows local launches fail before worker execution because this implementation has no Windows Job Object equivalent. Existing ownership receipts remain inspectable and verified Stop remains available. No PID or terminal-wide group is guessed when ownership is missing.

# Underway panel

`helmsman.underway/panel` uses the public task-read Underway view and run-command service. Install TypeScript and `@helmsman/plugin-sdk`, run `node build.mjs`, and package `dist/` with the Helmsman plugin CLI.

Each provider defines its unfinished-work view. Jira includes unfinished work assigned to the configured assignee independently of the ready queue; local tasks include work in progress or review. Unsupported views remain explicit. The panel preserves source labels, scoped reads, pagination limits, and source selection per panel instance.

Launch controls require one selected galleon and submit canonical source references. Command receipts remain in the host journal until explicitly dismissed. Retry delivery reuses the saved request identity; uncertain execution evidence directs the user to Recovery.

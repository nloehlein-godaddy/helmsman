# Underway panel

`helmsman.underway/panel` uses the public task-read Underway view and run-command service. Install TypeScript and `@helmsman/plugin-sdk`, run `node build.mjs`, and package `dist/` with the Helmsman plugin CLI.

Each provider defines its unfinished-work view. Jira includes unfinished work assigned to the configured assignee independently of the ready queue; local tasks include work in progress or review. Unsupported views remain explicit. The panel preserves source labels, scoped reads, pagination limits, and source selection per panel instance.

Launch controls require one selected galleon and submit canonical source references. Command receipts remain in the host journal until explicitly dismissed. Retry delivery reuses the saved request identity; uncertain execution evidence directs the user to Recovery.

When an upgraded host provides optional `taskContext@1`, each visible row can also open its canonical recorded run and pull request. The panel preserves the source task URL and uses only the returned presentation locators; it never associates work from ticket text, branch names, or pull request titles. Older hosts omit those buttons.

Delivery retry requires the host's optional `retry({ repo, requestId }, signal)` operation. It reads only the original caller-owned retained request and never reserves another identity. Missing requests remain unavailable; older hosts disable retry while keeping receipt checks available. New intentional submissions use `submit` separately.

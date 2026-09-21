# Activity panel

This standalone panel uses the released `@helmsman/plugin-sdk` task discovery, activity-read and pull-request-read services. Install the release SDK and TypeScript, then run `npm run build`; the resulting `dist` is an installable package.

The panel shows seven UTC calendar days of current Done task counts grouped by their retained completion date, per source view, plus actual source observations and PR opened/merged events. Reopened or deleted tasks are excluded. Complete count coverage means a full bounded current-source scan with usable completion dates, not a durable transition ledger. Counts reflect source task state, independently of worker results and PR merges. Unsupported, partial and unavailable histories remain explicit. Overlapping source views are not summed, and no sample activity or timestamps are manufactured.

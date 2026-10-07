---
version: 1
slug: "plugin-manager"
primary_target: "src/plugin-manager.ts"
related_targets: ["src/plugin-manager.css", "src/main.ts", "src/logic/navigation.ts"]
---

# Plugin management

Mode: Operate. Extend the approved Field Guide interface. User requested management of installed plugins in the UI after encountering an unavailable Jira source.

The core Config section owns Plugins at `/config?pane=plugins`, independent of optional frontend contributions. Preserve the header galleon selection, existing navigation colors, theme tokens, and plugin lifecycle safeguards.

Use a searchable list with plugin identity, version, origin, and configured state. Reveal runtime details and lifecycle actions inline. Keep Refresh and Install in the page header. Show archive identity and require explicit trust before installation; updates must match the chosen package. Bundled plugins update with Helmsman. Keep restart requirements visible through refresh and report rejected or unconfirmed changes without silently retrying.

Use responsive rows, native controls, compact SVG icons, keyboard focus restoration, and existing semantic colors. Safe start remains read-only. Source implementation replacement stays in Task sources, linked with the current galleon scope.

Validation covers desktop and touch layouts, navigation persistence, archive inspection and update, enable/disable/removal, restart messaging, malformed responses, and the read-only state. Real plugin installations and external task mutations are excluded from visual verification.

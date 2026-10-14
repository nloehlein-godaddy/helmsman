# Agent prompts

Global role instruction defaults for future agents. Helmsman adds task context and reporting requirements. Retained sessions keep their original prompts. The replaceable page composes `helmsman/agent-prompts-panel@1` panels using the `helmsman/agent-prompts@1` public service.

Edits are retained locally per role and applied explicitly. Refresh preserves edits and their original revision; conflicting edits require an explicit rebase before Save. Restore default prepares removal of an override and still requires Save.

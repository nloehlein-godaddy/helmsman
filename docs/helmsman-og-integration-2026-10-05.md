# OG integration — 2026-10-05

Source: `nathanloehlein/helmsman-og`, `og/main` at `2e47131`.
Rewrite base: `86efecd`; integration branch: `integration/og-oct05`.
This ledger covers the OG commits after the shared prompt update `8266189`.
Earlier feature parity is recorded in the [October 1 audit](helmsman-og-integration-2026-10-01.md) and [September 28 ledger](helmsman-og-integration-2026-09-28.md).

## Commit disposition

| OG commit | Change | Rewrite disposition |
| --- | --- | --- |
| `8aff970` | Chunk worker arguments | Launcher and fake-CLI equivalents already present in `f44db4d` and `86efecd`. Fixed the remaining continuation reader to reassemble saved `--input=` chunks while retaining legacy raw JSON support. |
| `00bad80` | Exclude runtime artifacts from test discovery | Added `.agent-workspaces/**` and `.helmsman-runs/**` to Vitest exclusions, preserving its standard exclusions. |
| `f6efe4f` | Theme palettes and appearance preview | Ported palette roles, contrast checks, preview, Config customization and core styling. Existing shell, startup, scope and question-attention behavior retained. `a548543` on the other OG branch is patch-equivalent. |
| `d49c702` | Portable continuation paths and updated UI assertions | Continuation recognizes POSIX/Windows paths and source `.ts`/packaged `.js` launchers. Main theme assertions use the palette catalog. Legacy Recent PR tests have different APIs; existing plugin/browser coverage remains authoritative. |
| `a067ba9` | Start uncertain-delivery test timer after startup | Already covered by separate instruction and startup request deadlines in POST; no duplicated change. |
| `2e47131` | Readable form surfaces and borders | Added control tokens to core and active plugin-owned form styles, preserved button rules, and used theme foregrounds for Costs hover. Incremented the 21 affected plugin package patch versions. |

## Architecture and recovery

Plugin forms consume `--control-bg` and `--control-border` with their previous token fallbacks; package boundaries and SDK contracts are unchanged. Product feedback inherits global field styling. Unused compatibility styles are not revived. See [theme palettes](themes.md).

Continuation decodes the original saved command before the existing artifact, provider, revision and publication checks. It does not select a new provider or replace retained evidence. The recovery guide and both process diagrams describe this step.

## Verification

- Focused continuation/launcher tests cover generated long inputs, raw/chunked input, source/packaged launchers, path separators and retained provider checkpoints.
- Theme/bootstrap/render tests and affected plugin tests pass; main theme persistence assertions use the updated catalog.
- Production and distribution builds include TypeScript checking; all 11 distribution checks pass across the full run and targeted recheck. The packaged-worker assertion now verifies bounded chunks and reconstructed task data instead of a fixed argument count.
- All 38 browser tests pass across the full run and targeted recheck. Coverage includes desktop/mobile composition, Config, plugin pages, launch forms, question attention and recovery. Updated fixtures track the shipped clarification package version and the existing scoped voyage URL; expected palette screenshots are refreshed and representative images inspected.
- Installed plugin browser checks exercise Source Settings, task views and Todos with application-source access denied. Their four theme baselines are refreshed.
- Independent post-commit architecture review found no material issues in continuation, theme reset behavior or plugin boundaries.

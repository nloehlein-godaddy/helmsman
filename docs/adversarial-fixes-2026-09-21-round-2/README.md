# Second-review fix evidence

Read the [fix ledger](../adversarial-fixes-2026-09-21-round-2.md) for commit mapping, acceptance and limits. The original review evidence remains historical.

Logs preserve the integrated full-suite gate and targeted final lifecycle/build/distribution/installed checks. `installed.log` contains the initial Docker-fixture failure; `installed-host.log` and `final-installed.log` record its corrected passing runs. Full-suite and targeted counts overlap.

The cleanup probe is stored with a final `.txt` suffix to keep it out of test discovery. For replay, restore the `.mts` extension in a temporary directory and relocate its fixture import and distribution path to your own disposable checkout. Never use a user's runtime. Screenshots show isolated fixture data. No credentials, databases, model transcripts or user runtime data are included.

`sha256.json` covers every evidence file and this index, excluding itself. The OG comparison is a source-level evaluation; it did not import or run those features.

_Helmsman · not reported - not reported_

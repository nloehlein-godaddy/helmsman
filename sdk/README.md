# Public SDK release metadata

`version.json` versions the SDK independently of the application. `baseline/v1` contains the reviewed declarations for the supported protocol major, including recovery-only contracts. The distribution generator emits the current public SDK and checks compatibility against this baseline before publishing a release directory.

Do not regenerate the baseline to bypass a compatibility failure. See the [compatibility policy](../docs/plugin-compatibility.md) and [author quickstart](../docs/plugin-quickstart.md).

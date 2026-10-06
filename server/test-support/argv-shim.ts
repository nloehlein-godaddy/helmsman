/** Bash shim that forwards its argv to a node script through a NUL-separated file, so long arguments never reach node's own argv. */
export const bashShimPassingLongArgvViaFile = (script: string) => `#!/bin/bash\nf=$(/usr/bin/mktemp "\${TMPDIR:-/tmp}/hm-argv.XXXXXX")\n[ $# -gt 0 ] && printf '%s\\0' "$@" > "$f"\n`
  + `TEST_ARGS_FILE="$f" TEST_ID="\${0##*/}" exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`;

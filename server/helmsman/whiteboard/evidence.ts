import type { PullRequestInspectDiffV1 } from '../../../src/plugins/pull-request-inspect';

export function boundWhiteboardDiff(diff: PullRequestInspectDiffV1): PullRequestInspectDiffV1 {
  const quota = Math.floor(32_768 / Math.max(1, diff.files.length));
  let truncated = diff.truncated;
  const files = diff.files.map(file => {
    if (file.patch === null || file.patchStatus === 'preview' && Buffer.byteLength(file.patch) <= quota) return file;
    truncated = true;
    const hunks: string[] = []; let used = 0;
    const sections = file.patch.split(/(?=^@@ )/m);
    for (const section of sections) {
      const lines = section.split('\n'); const header = lines.shift() ?? '';
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
      if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) continue;
      const kept: string[] = []; let base = 0; let head = 0;
      for (const line of lines) {
        if (!/^[ +\\-]/.test(line)) continue;
        const size = Buffer.byteLength(line) + 1;
        if (used + size + 128 > quota) break;
        used += size; kept.push(line);
        if (line.startsWith(' ') || line.startsWith('-')) base++;
        if (line.startsWith(' ') || line.startsWith('+')) head++;
      }
      if (kept.length) { const normalized = `@@ -${match[1]},${base} +${match[2]},${head} @@\n${kept.join('\n')}`; hunks.push(normalized); used += Buffer.byteLength(normalized.split('\n')[0]!) + 1; }
      if (used + 128 >= quota) break;
    }
    return { ...file, patch: hunks.length ? hunks.join('\n') : null, patchStatus: hunks.length ? 'truncated' as const : 'unavailable' as const };
  });
  return { ...diff, files, truncated, quality: truncated ? 'partial' : 'complete' };
}

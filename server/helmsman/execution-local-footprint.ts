import type { WorkRefV1 } from '../../src/plugins/tasks';
import { exclusiveExecutionFootprint, parseExecutionFootprint, type ExecutionFootprint, type ExecutionResource } from './execution-footprint';

export function localExecutionFootprint(input: {
  runId: string; repo: string; checkout: { path: string; commonDirectory: string; workspacePath: string };
  trustedLocalHost: boolean; mode: 'coding' | 'review' | 'branch'; source: WorkRefV1 | null; unknownTask: boolean;
  pullRequestNumber?: number; retry: boolean; branch?: string;
}): ExecutionFootprint {
  const checkout = { path: input.checkout.path, commonDirectory: input.checkout.commonDirectory };
  const workspace: ExecutionResource = { kind: 'workspace', namespace: 'filesystem', identity: input.checkout.workspacePath };
  const exclusive = () => {
    const footprint = exclusiveExecutionFootprint(input.runId, input.repo, checkout);
    return parseExecutionFootprint({ ...footprint, resources: [...footprint.resources, workspace] });
  };
  if (!input.trustedLocalHost || input.unknownTask || input.mode === 'branch' && !input.branch || input.retry) return exclusive();
  const resources: ExecutionResource[] = [workspace];
  if (input.source) resources.push({ kind: 'task', namespace: input.source.sourceId, identity: input.source.externalId });
  const github = `github.com/${input.repo.toLowerCase()}`;
  if (input.mode === 'review') {
    if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber! < 1) return exclusive();
    resources.push({ kind: 'pull-request', namespace: github, identity: String(input.pullRequestNumber) });
  } else {
    const identity = `refs/heads/${input.mode === 'branch' ? input.branch : `agent/${input.runId}`}`;
    if (input.mode === 'branch' && input.pullRequestNumber) resources.push({ kind: 'pull-request', namespace: github, identity: String(input.pullRequestNumber) });
    resources.push({ kind: 'branch', namespace: github, identity }, { kind: 'branch', namespace: `git:${checkout.commonDirectory}`, identity });
  }
  return parseExecutionFootprint({ version: 1, runId: input.runId, repo: input.repo, completeness: 'verified', checkout, resources });
}

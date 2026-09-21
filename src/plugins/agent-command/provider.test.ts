import { describe, expect, it } from 'vitest';
import { commandAgentProvider, commandArgs } from './provider';

const input = { version: 1 as const, prompt: 'ignored', model: null, effort: null, stage: 'direct' as const, summaryCorrection: false, task: { ticketId: 'T-1', repo: 'org/repo', title: 'Title here' } };

describe('command agent provider', () => {
  it('expands the configured template and leaves an empty template unconfigured', () => {
    expect(commandArgs('runner {ticket} {repo} {title}', input)).toEqual(['runner', 'T-1', 'org/repo', 'Title', 'here']);
    expect(commandAgentProvider('').buildCommand(input)).toEqual({ cmd: '', args: [] });
  });

  it('has no implicit workflow capabilities and extracts legacy pull references', () => {
    const provider = commandAgentProvider('runner');
    expect(provider.metadata).toMatchObject({ supportsPrePr: false, docker: null, reviewDelegation: 'none' });
    expect(provider.parseLine('opened PR #12')).toEqual({ kind: 'log', text: 'opened PR #12', prNumber: 12 });
  });
});

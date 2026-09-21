import type { AgentCommandInputV1, AgentEventV1, AgentProviderV1 } from '@helmsman/plugin-sdk';

export function commandArgs(template: string, input: AgentCommandInputV1): readonly string[] {
  return template.trim().split(/\s+/).flatMap(token => token
    .replaceAll('{ticket}', input.task.ticketId).replaceAll('{repo}', input.task.repo).replaceAll('{title}', input.task.title).split(/\s+/)).filter(Boolean);
}

export function commandAgentProvider(template: string): AgentProviderV1 {
  return {
    metadata: { version: 1, label: 'Command', defaults: { model: null, effort: null }, review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } }, reviewSkills: [], reviewDelegation: 'none', supportsPrePr: false, docker: null, costReporting: 'delta' },
    buildCommand(input) { const [cmd = '', ...args] = commandArgs(template, input); return { cmd, args }; },
    parseLine(line): AgentEventV1 | null { if (!line) return null; const match = line.match(/(?:pull\/|PR[ #]*)(\d+)/i); return { kind: 'log', text: line, ...(match ? { prNumber: Number(match[1]) } : {}) }; },
  };
}

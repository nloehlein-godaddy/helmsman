export function jiraIssue(overrides: Record<string, unknown> = {}) {
  return { id: '10001', key: 'TASK-1', fields: { summary: 'Implement the feature', updated: '2026-09-20T00:00:00.000Z', status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    priority: { name: 'High' }, project: { key: 'TASK' }, assignee: null as { accountId: string } | null, reporter: { accountId: 'reporter-id' }, description: null, ...overrides }, names: {} };
}

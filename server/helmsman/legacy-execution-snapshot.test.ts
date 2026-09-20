import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import type { AgentTask } from './agents/adapter';
import { legacyExecutionSettings, nonsecretExecutionTask, restoreExecutionConfig } from './legacy-execution-snapshot';
import type { ExecutionSnapshot } from './execution-store';

describe('legacy execution bindings', () => {
  it('excludes every supported task capability without changing the live launch task', () => {
    const task: AgentTask = { repo: 'org/repo', ticketId: 'TASK-1', title: 'test', jiraBaseUrl: '',
      clarification: { questionsPath: '/questions', answersPath: '/answers', gateToken: 'private-gate-token' },
      dockerExecution: { image: 'sha256:abc', gatewayUrl: 'http://gateway', capability: 'private-provider-token', runId: 'run' } };
    expect(JSON.stringify(nonsecretExecutionTask(task))).not.toContain('private-');
    expect(task.clarification?.gateToken).toBe('private-gate-token');
    expect(task.dockerExecution?.capability).toBe('private-provider-token');
  });

  it('restores pinned policy with rotated credentials for the same disabled source connection', () => {
    const env = { JIRA_BASE_URL: 'https://jira.example', JIRA_EMAIL: 'operator@example.com', JIRA_API_TOKEN: 'original', AGENT_MAX_ATTEMPTS: '2' };
    const original = loadConfig(env);
    const snapshot = { settings: { execution: legacyExecutionSettings(original) } } as unknown as ExecutionSnapshot;
    const current = loadConfig({ ...env, JIRA_API_TOKEN: 'rotated', AGENT_MAX_ATTEMPTS: '5' });
    current.jiraEnabled = false;
    const restored = restoreExecutionConfig(snapshot, current);
    expect(restored).toMatchObject({ jiraEnabled: false, maxAttempts: 2, jira: { apiToken: 'rotated', email: env.JIRA_EMAIL } });
    expect(() => restoreExecutionConfig(snapshot, loadConfig({ ...env, JIRA_EMAIL: 'different@example.com' }))).toThrow('recorded service connection');
  });
});

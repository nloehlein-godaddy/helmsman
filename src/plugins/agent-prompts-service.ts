import { createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { AGENT_PROMPT_LIMITS_V1, parseAgentPromptSettingsSaveV1, parseAgentPromptSettingsSnapshotV1, type AgentPromptSettingsServiceV1 } from './agent-prompts';
export function createHostAgentPromptSettingsService(lifetime: AbortSignal, options: ClarificationHostOptions): AgentPromptSettingsServiceV1 {
  const operation = createClarificationTransport(lifetime, options, AGENT_PROMPT_LIMITS_V1.snapshotBytes);
  return { version: 1,
    snapshot: signal => operation(signal).request('/api/agent-prompts', parseAgentPromptSettingsSnapshotV1),
    save: (input, signal) => operation(signal).request('/api/agent-prompts', parseAgentPromptSettingsSnapshotV1, parseAgentPromptSettingsSaveV1(input)),
  };
}

import type { WorkflowBackendModuleV1 } from '@helmsman/plugin-sdk';
import { codingWorkflowProvider, branchWorkflowProvider } from './provider.js';

import { codingPromptRoles } from './prompt-instructions.js';

const module: WorkflowBackendModuleV1 = {
  activate(context) {
    const maxRounds = typeof context.settings.maxRounds === 'number' ? context.settings.maxRounds : 3;
    const stageTimeoutMinutes = typeof context.settings.stageTimeoutMinutes === 'number' ? context.settings.stageTimeoutMinutes : 45;
    const prompts = Object.fromEntries(codingPromptRoles.map(role => [role.settingKey, typeof context.settings[role.settingKey] === 'string' ? context.settings[role.settingKey] : role.defaultText]));
    context.registerWorkflow('coding', codingWorkflowProvider({ maxRounds, stageTimeoutMinutes, ...prompts }));
    context.registerWorkflow('branch', branchWorkflowProvider({ maxRounds, stageTimeoutMinutes, ...prompts }));
  },
};

export default module;

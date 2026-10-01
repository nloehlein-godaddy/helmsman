import type { WorkflowBackendModuleV1 } from '@helmsman/plugin-sdk';
import { codingWorkflowProvider, branchWorkflowProvider } from './provider.js';

const module: WorkflowBackendModuleV1 = {
  activate(context) {
    const maxRounds = typeof context.settings.maxRounds === 'number' ? context.settings.maxRounds : 3;
    const stageTimeoutMinutes = typeof context.settings.stageTimeoutMinutes === 'number' ? context.settings.stageTimeoutMinutes : 45;
    context.registerWorkflow('coding', codingWorkflowProvider({ maxRounds, stageTimeoutMinutes }));
    context.registerWorkflow('branch', branchWorkflowProvider({ maxRounds, stageTimeoutMinutes }));
  },
};

export default module;

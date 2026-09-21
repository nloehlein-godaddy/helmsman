import type { WorkflowBackendModuleV1 } from '@helmsman/plugin-sdk';
import { reviewWorkflowProvider } from './provider.js';

const module: WorkflowBackendModuleV1 = {
  activate(context) {
    context.registerWorkflow('review', reviewWorkflowProvider());
  },
};

export default module;

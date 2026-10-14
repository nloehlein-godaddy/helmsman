import type { WorkflowBackendModuleV1 } from '@helmsman/plugin-sdk';
import { reviewWorkflowProvider } from './provider.js';

const module: WorkflowBackendModuleV1 = {
  activate(context) {
    context.registerWorkflow('review', reviewWorkflowProvider({ promptReview: typeof context.settings.promptReview === 'string' ? context.settings.promptReview : undefined }));
  },
};

export default module;

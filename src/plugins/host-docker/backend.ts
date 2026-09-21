import type { ExecutionHostBackendModuleV1 } from '@helmsman/plugin-sdk';
import { createDockerExecutionHost } from './provider.js';

const module: ExecutionHostBackendModuleV1 = {
  activate(context) {
    const image = context.settings.image;
    if (typeof image !== 'string' || !image) throw new Error('Docker image setting is required');
    context.registerExecutionHost('docker', createDockerExecutionHost({ image }));
  },
};

export default module;

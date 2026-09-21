import type { ExecutionHostBackendModuleV1 } from '@helmsman/plugin-sdk';
import { createCmuxExecutionHost, createDetachedExecutionHost, createWeztermExecutionHost } from './provider.js';

const module: ExecutionHostBackendModuleV1 = {
  activate(context) {
    const cmuxSocketPath = typeof context.settings.cmuxSocketPath === 'string' ? context.settings.cmuxSocketPath : '';
    const weztermBin = typeof context.settings.weztermBin === 'string' && context.settings.weztermBin
      ? context.settings.weztermBin
      : 'wezterm';
    const weztermRunWorkspace = typeof context.settings.weztermRunWorkspace === 'string' && context.settings.weztermRunWorkspace
      ? context.settings.weztermRunWorkspace
      : 'helmsman-runs';
    context.registerExecutionHost('detached', createDetachedExecutionHost());
    context.registerExecutionHost('cmux', createCmuxExecutionHost({ socketPath: cmuxSocketPath }));
    context.registerExecutionHost('wezterm', createWeztermExecutionHost({ bin: weztermBin, workspace: weztermRunWorkspace }));
  },
};

export default module;

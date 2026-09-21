import type { NativeTerminalBackendModuleV1 } from '@helmsman/plugin-sdk';
import { createCmuxNativeTerminal } from './provider.js';

const module: NativeTerminalBackendModuleV1 = {
  activate(context) {
    const binary = typeof context.settings.binary === 'string' && context.settings.binary ? context.settings.binary : 'cmux';
    const socketPath = typeof context.settings.socketPath === 'string' ? context.settings.socketPath : '';
    context.registerNativeTerminal('cmux', createCmuxNativeTerminal({ binary, socketPath }));
  },
};

export default module;

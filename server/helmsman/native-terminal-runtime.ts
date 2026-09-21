import type { NativeTerminalProviderV1 } from '../../src/plugins/native-terminal';
import { ClarificationServiceError } from './clarification-service-common';
import type { NativeTerminalProviderRegistry } from './native-terminal-providers';
import { assertNativeTerminalSelectionCurrent, resolveNativeTerminalSelection } from './native-terminal-selection';
import { persistenceHash } from './persistence';

export function createSelectedNativeTerminalRuntime(options: {
  root: string; registry: NativeTerminalProviderRegistry; defaultProviderId: string;
}) {
  const selection = { ...options, kind: 'terminal' as const };
  function current() {
    try {
      const resolved = resolveNativeTerminalSelection(selection);
      const registration = options.registry.resolve(resolved.record.binding);
      assertNativeTerminalSelectionCurrent(selection, resolved);
      return { resolved, provider: registration.provider };
    } catch { throw new ClarificationServiceError(503, 'service-unavailable'); }
  }
  const bridge: Pick<NativeTerminalProviderV1, 'listTabs' | 'readScreen' | 'send' | 'sendKey'> = {
    listTabs: signal => current().provider.listTabs(signal),
    readScreen: (surface, lines, signal) => current().provider.readScreen(surface, lines, signal),
    send: (surface, text, enter, signal) => current().provider.send(surface, text, enter, signal),
    sendKey: (surface, key, signal) => current().provider.sendKey(surface, key, signal),
  };
  return {
    bridge,
    sessionIdentity(): string {
      const { resolved, provider } = current();
      return persistenceHash({ provider: resolved.record, revision: resolved.revision, session: provider.sessionIdentity() });
    },
  };
}

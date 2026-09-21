import type { PluginPageModule } from '../sdk';
import { mountClarifications } from '../../renderClarifications';

const page: PluginPageModule = { mount(container, context) {
  const { clarifications, clarificationCommands, suggestedContacts } = context.services ?? {};
  if (!clarifications || !clarificationCommands || !suggestedContacts) throw new Error('Clarification services are unavailable.');
  let state = context.state;
  const mounted = mountClarifications(container, { repo: () => state.repo,
    services: { clarifications, clarificationCommands, suggestedContacts }, signal: context.signal, visible: state.visible });
  return {
    update(next) { state = next; mounted.setVisible(next.visible); if (next.visible) return mounted.refresh(); },
    refresh: () => mounted.refresh(), dispose: () => mounted.destroy(),
  };
} };
export default page;

import type { PluginPageModule } from '@helmsman/plugin-sdk';
import { mountClarifications } from './controller.js';
import { contributionIdentity } from './validation.js';

const page: PluginPageModule = { mount(container, context) {
  const contributionId = contributionIdentity(context.contributionId);
  const { clarifications, clarificationCommands, suggestedContacts } = context.services ?? {};
  if (clarifications?.version !== 1 || clarificationCommands?.version !== 1 || suggestedContacts?.version !== 1) throw new Error('Clarification services are unavailable.');
  let state = context.state;
  const mounted = mountClarifications(container, { contributionId, repo: () => state.repo, pirateMode: () => state.pirateMode, navigate: href => context.navigate(href),
    services: { clarifications, clarificationCommands, suggestedContacts }, signal: context.signal, visible: state.visible });
  context.onDispose(() => mounted.destroy());
  return {
    update(next) { state = next; mounted.setVisible(next.visible); if (next.visible) return mounted.refresh(); },
    refresh: () => mounted.refresh(), dispose: () => mounted.destroy(),
  };
} };
export default page;

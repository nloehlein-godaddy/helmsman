import type { PageView } from './routes';
import { term } from './terminology';
import { appPages, builtinPageSlots, supportsPageSlot, RUNS_PAGE_SLOT } from '../plugins/builtins';

interface NavigationChild {
  slot: string;
  label: string;
}

interface NavigationSection {
  view: 'config' | 'runs';
  children: readonly NavigationChild[];
}

export interface NavigationRoute {
  active: PageView;
  pluginSlot?: string;
  pluginPage?: string;
}

const sections: readonly NavigationSection[] = [
  { view: 'config', children: [
    { slot: 'helmsman/source-settings-page', label: 'Task sources' },
    { slot: 'helmsman/execution-settings-page', label: 'Execution' },
    { slot: 'helmsman/feedback-settings-page', label: 'Product feedback' },
    { slot: 'helmsman/jira-settings-page', label: 'Jira' },
    { slot: 'helmsman/github-settings-page', label: 'GitHub' },
    { slot: 'helmsman/communication-page', label: 'Notifications' },
    { slot: 'helmsman/local-git-page', label: 'Local Git' },
  ] },
  { view: 'runs', children: [
    { slot: 'helmsman/run-history-page', label: 'History' },
    { slot: 'helmsman/run-viewer-page', get label() { return term('runDetails'); } },
  ] },
];

function matchesSlot(route: NavigationRoute, slotId: string): boolean {
  if (route.pluginSlot) return route.pluginSlot === slotId;
  if (!route.pluginPage) return false;
  const slot = builtinPageSlots.find(value => value.id === slotId);
  const page = appPages.getPage(route.pluginPage);
  return slot?.defaultContributionId === route.pluginPage || Boolean(page && supportsPageSlot(page, slotId));
}

export function navigationSection(route: NavigationRoute): NavigationSection | null {
  return sections.find(section => section.children.some(child => matchesSlot(route, child.slot))
    || (section.view === 'runs' && matchesSlot(route, RUNS_PAGE_SLOT))
    || (!route.pluginSlot && !route.pluginPage && section.view === route.active)) ?? null;
}

export function navigationChild(route: NavigationRoute): NavigationChild | null {
  return navigationSection(route)?.children.find(child => matchesSlot(route, child.slot)) ?? null;
}

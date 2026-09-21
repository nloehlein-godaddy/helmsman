import type { PageSlot } from './sdk';

export const COSTS_PAGE_SLOT = 'helmsman/costs-page';
export const COSTS_PAGE_ID = 'helmsman.costs/page';
export const COSTS_PAGE_ALIAS = '/outcomes';
export const HELM_PAGE_SLOT = 'helmsman/helm-page';
export const HELM_PAGE_ID = 'helmsman.helm/page';
export const HELM_PAGE_ALIAS = '/helm';
export const HELM_PANEL_CONTRACT = 'helmsman/helm-panel';

interface BuiltinPageSlot extends PageSlot {
  readonly panelContract?: string;
}

export const builtinPageSlots: readonly BuiltinPageSlot[] = Object.freeze([
  Object.freeze({ id: COSTS_PAGE_SLOT, alias: COSTS_PAGE_ALIAS, defaultContributionId: COSTS_PAGE_ID }),
  Object.freeze({ id: HELM_PAGE_SLOT, alias: HELM_PAGE_ALIAS, aliases: Object.freeze(['/']),
    defaultContributionId: HELM_PAGE_ID, panelContract: HELM_PANEL_CONTRACT }),
]);

export function isBuiltinPageSlot(id: string): boolean {
  return builtinPageSlots.some(slot => slot.id === id);
}

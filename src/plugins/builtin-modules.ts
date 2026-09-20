import { COSTS_PAGE_ID } from './builtins';
import costsPage from './costs/page';
import { PluginPageModules } from './modules';

export const appPageModules = new PluginPageModules();

const removeCostsModule = appPageModules.register(COSTS_PAGE_ID, costsPage);

export function disableBuiltinPageModules(): void {
  removeCostsModule();
}

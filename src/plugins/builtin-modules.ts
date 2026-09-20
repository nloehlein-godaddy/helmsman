import { fetchOutcomes, saveOutcomeAssessment } from '../data/outcomeClient';
import { routeHref } from '../logic/routes';
import { COSTS_PAGE_ID } from './builtins';
import { createCostsPageModule } from './costs/page';
import { PluginPageModules } from './modules';
import '../outcomes.css';

export const appPageModules = new PluginPageModules();

const removeCostsModule = appPageModules.register(COSTS_PAGE_ID, createCostsPageModule({
  read: fetchOutcomes,
  save: saveOutcomeAssessment,
  runHref: (repo, runId) => routeHref({ view: 'runs', repo, run: runId }),
}));

export function disableBuiltinPageModules(): void {
  removeCostsModule();
}

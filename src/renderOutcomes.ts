import { routeHref } from './logic/routes';
import { renderAppShell, type HelmHeadOpts } from './render';
import { renderCostsContent, type OutcomesViewState } from './plugins/costs/render';

export type { OutcomesViewState } from './plugins/costs/render';

export function renderOutcomesView(state: OutcomesViewState, opts: HelmHeadOpts): string {
  return renderAppShell({ ...opts, active: 'outcomes' }, renderCostsContent(state, runId => routeHref({ view: 'runs', repo: opts.selectedRepo, run: runId })));
}

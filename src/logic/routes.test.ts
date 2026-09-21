import { describe, expect, it } from 'vitest';
import { appPages, CLARIFICATIONS_PAGE_ID, CLARIFICATIONS_PAGE_SLOT, clarificationsManifest, compatibilityClarificationsManifest, RUNS_PAGE_ID, RUNS_PAGE_SLOT, runsManifest } from '../plugins/builtins';
import { parseRoute, routeHref, type AppRoute, type PageView } from './routes';

const parse = (href: string) => parseRoute(new URL(href, 'https://helmsman.example'));

describe('routes', () => {
  it('retains canonical run identity independently of header scope without downgrading malformed explicit targets', () => {
    const route = parse('/run-viewer?repo=org/a&run=run-1&runRepo=org/b');
    expect(route).toMatchObject({ view: 'plugin', repo: 'org/a', run: 'run-1', runRepo: 'org/b' });
    expect(parse(routeHref(route))).toEqual(route);
    expect(parse('/run-history?repo=org/a&run=run-1&runRepo=../invalid')).toMatchObject({ repo: 'org/a', run: null });
    expect(parse('/run-history?repo=org/a&run=run-1')).toMatchObject({ repo: 'org/a', run: 'run-1' });
    expect(parse('/run-history?repo=org/a&run=run-1').runRepo).toBeUndefined();
    expect(routeHref({ ...route, run: null })).not.toContain('runRepo');
  });

  it('retains a missing panel locator and namespaced route state across scope changes', () => {
    const state = JSON.stringify({ 'example.missing/panel': { version: 2, value: { filter: 'mine' } } });
    const route = parse(`/plugins/example.missing/page?repo=org/a&panel=instance-one&panelState=${encodeURIComponent(state)}`);
    expect(route).toMatchObject({ view: 'plugin', panelInstance: 'instance-one', panelState: state });
    expect(parse(routeHref({ ...route, repo: 'org/b' }))).toMatchObject({ repo: 'org/b', panelInstance: 'instance-one', panelState: state });
  });

  it('rejects malformed or unbounded panel route data without deleting unrelated scope', () => {
    expect(parse('/plugins/example.missing/page?repo=org/a&panel=../escape')).toMatchObject({ repo: 'org/a' });
    expect(parse('/plugins/example.missing/page?panel=../escape').panelInstance).toBeUndefined();
    for (const state of ['[]', '{"invalid":{}}', JSON.stringify({ 'example.panel/panel': { version: 1, value: 'x'.repeat(8192) } })]) {
      expect(parse(`/plugins/example.missing/page?repo=org/a&panel=instance&panelState=${encodeURIComponent(state)}`))
        .toMatchObject({ repo: 'org/a', panelInstance: 'instance', panelState: null });
    }
  });

  it.each([
    ['/', 'plugin'], ['/helm', 'plugin'], ['/triage', 'plugin'],
    ['/terminal', 'cmux'], ['/terminal/', 'cmux'], ['/cmux', 'cmux'], ['/bugs', 'plugin'], ['/prs', 'prs'], ['/pr', 'prs'],
    ['/config', 'config'], ['/runs', 'plugin'], ['/runs/', 'plugin'], ['/unknown', 'dashboard'],
    ['/todos', 'plugin'], ['/todos/', 'plugin'],
  ])('resolves %s to %s', (path, view) => {
    expect(parse(path).view).toBe(view);
  });

  it('returns explicit nulls for absent parameters', () => {
    expect(parse('/')).toEqual({
      view: 'plugin', pluginPage: 'helmsman.helm/page', pluginSlot: 'helmsman/helm-page', repo: null, prRepo: null, pane: null, pr: null, run: null,
      mode: null, ticket: null, surface: null,
    });
  });

  it('loads a review form route without requiring a tracked repo', () => {
    expect(parse('/runs?repo=another-org%2Fsome.repo&pane=newrun&pr=10280&mode=review')).toMatchObject({
      view: 'plugin', pluginPage: RUNS_PAGE_ID, repo: 'another-org/some.repo', pane: 'newrun', pr: 10280, mode: 'review',
    });
  });

  it.each(['/prs', '/runs'])('keeps header scope separate from an explicit PR panel repository at %s', path => {
    const route = parse(`${path}?repo=owner/header&prRepo=other/panel&pr=42`);
    expect(route).toMatchObject({ repo: 'owner/header', prRepo: 'other/panel', pr: 42 });
    expect(parse(routeHref(route))).toEqual(route);
  });

  it('preserves All galleons while opening an explicit repository PR', () => {
    const route = parse('/runs?prRepo=other/panel&pr=42&pane=newrun&mode=review');
    expect(route).toMatchObject({ repo: null, prRepo: 'other/panel', pr: 42, pane: 'newrun', mode: 'review' });
    expect(parse(routeHref(route))).toEqual(route);
  });

  it('retains legacy PR links without adding an implicit override', () => {
    const route = parse('/pr?repo=owner/legacy&pr=42');
    expect(route).toMatchObject({ repo: 'owner/legacy', prRepo: null, pr: 42 });
    expect(routeHref(route)).toBe('/prs?repo=owner%2Flegacy&pr=42');
  });

  it.each(['', 'bad repo', 'owner/..', 'owner/repo/extra'])('does not reinterpret an invalid explicit PR override as the header repository: %j', prRepo => {
    const route = parse(`/prs?repo=owner/header&prRepo=${encodeURIComponent(prRepo)}&pr=42`);
    expect(route).toMatchObject({ repo: 'owner/header', prRepo: null, pr: null });
    expect(routeHref(route)).toBe('/prs?repo=owner%2Fheader');
  });

  it('validates header scope independently of an explicit PR target', () => {
    expect(parse('/prs?repo=bad&prRepo=other/panel&pr=42'))
      .toMatchObject({ repo: null, prRepo: 'other/panel', pr: 42 });
  });

  it.each(['/helm', '/todos', '/terminal', '/config'])('ignores PR panel overrides outside PR pages: %s', path => {
    const route = parse(`${path}?prRepo=other/panel&pr=42`);
    expect(route.prRepo).toBeNull();
    expect(route.pr).toBeNull();
    expect(routeHref(route)).toBe(path);
  });

  it('retains an existing run identifier independently of a repo', () => {
    expect(parse('/runs?run=99723f3e-ff89-433a-8621-f30a48b96fd4').run)
      .toBe('99723f3e-ff89-433a-8621-f30a48b96fd4');
  });

  it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '9007199254740992', ' 12', '12x'])('ignores malformed PR number %s', (pr) => {
    expect(parse(`/prs?repo=owner/repo&pr=${encodeURIComponent(pr)}`).pr).toBeNull();
  });

  it.each(['owner', '/repo', 'owner/', 'owner/repo/extra', '-owner/repo', 'owner/..', 'owner/a b', 'owner/r?evil'])('ignores malformed repo %s and its PR', (repo) => {
    const route = parse(`/prs?repo=${encodeURIComponent(repo)}&pr=123`);
    expect(route.repo).toBeNull();
    expect(route.pr).toBeNull();
  });

  it('requires a repo to interpret a PR number', () => {
    expect(parse('/prs?pr=123').pr).toBeNull();
  });

  it.each([
    ['dashboard', 'repoprs'], ['triage', 'mine'], ['cmux', 'screen'],
    ['prs', 'review-requests'], ['runs', 'tasks'],
  ] as [PageView, string][])('accepts a pane belonging to %s', (view, pane) => {
    expect(parse(routeHref({ view, pane })).pane).toBe(pane);
  });

  it.each(['/bugs?pane=recent', '/config?pane=newrun', '/triage?pane=diff', '/prs?pane=mine'])('ignores panes outside their page: %s', (href) => {
    expect(parse(href).pane).toBeNull();
  });

  it.each(['/runs?mode=review', '/runs?mode=rerun', '/prs?mode=review', '/prs?mode=rerun'])('accepts PR actions at %s', (href) => {
    expect(parse(href).mode).toBe(href.split('=')[1]);
  });

  it.each(['/helm?mode=review', '/triage?mode=rerun', '/runs?mode=launch'])('ignores invalid action scopes: %s', (href) => {
    expect(parse(href).mode).toBeNull();
  });

  it.each(['../run', 'with space', 'a'.repeat(129), '<script>'])('ignores invalid run IDs: %s', (run) => {
    expect(parse(`/runs?run=${encodeURIComponent(run)}`).run).toBeNull();
  });

  it('normalizes Jira keys and ignores invalid ticket values', () => {
    expect(parse('/runs?ticket=airo_2-123').ticket).toBe('AIRO_2-123');
    expect(parse('/runs?ticket=123').ticket).toBeNull();
    expect(parse('/runs?ticket=AIRO-0').ticket).toBeNull();
  });

  it('accepts only positive cmux surface references on the terminal page', () => {
    expect(parse('/terminal?surface=surface%3A15').surface).toBe('surface:15');
    expect(parse('/runs?surface=surface%3A15').surface).toBeNull();
    expect(parse('/terminal?surface=surface%3A0').surface).toBeNull();
    expect(parse('/terminal?surface=workspace%3A15').surface).toBeNull();
    expect(parse('/terminal?surface=surface%3A9007199254740992').surface).toBeNull();
  });

  it('accepts bare wezterm pane ids, which are 0-based', () => {
    expect(parse('/cmux?surface=0').surface).toBe('0');
    expect(parse('/cmux?surface=7').surface).toBe('7');
    expect(parse('/runs?surface=7').surface).toBeNull();
    expect(parse('/cmux?surface=9007199254740992').surface).toBeNull();
    expect(parse('/cmux?surface=-1').surface).toBeNull();
    expect(parse('/cmux?surface=1;rm').surface).toBeNull();
  });

  it('serializes canonical paths and encoded parameters', () => {
    expect(routeHref({ view: 'dashboard' })).toBe('/helm');
    expect(routeHref({ view: 'prs', repo: 'owner/my.repo', pane: 'diff', pr: 42 }))
      .toBe('/prs?repo=owner%2Fmy.repo&pane=diff&pr=42');
    expect(routeHref({ view: 'cmux', surface: 'surface:15' })).toBe('/terminal?surface=surface%3A15');
    expect(routeHref(parse('/cmux?repo=owner/repo&pane=screen&surface=surface:15')))
      .toBe('/terminal?repo=owner%2Frepo&pane=screen&surface=surface%3A15');
    expect(routeHref(parse('/pr?repo=owner/repo&pr=42'))).toBe('/prs?repo=owner%2Frepo&pr=42');
  });

  it('omits invalid, null, and unspecified parameters when serializing', () => {
    expect(routeHref({ view: 'prs', repo: 'bad repo', pr: 42, pane: 'recent', run: null }))
      .toBe('/prs');
    expect(routeHref({ view: 'runs', pr: -1, ticket: 'foo-42' })).toBe('/runs?ticket=FOO-42');
  });

  it('round-trips a complete route while discarding unrelated query and fragment values', () => {
    const route: AppRoute = {
      view: 'runs', repo: 'owner/repo', prRepo: 'other/repo', pane: 'newrun', pr: 123,
      run: 'run_42', mode: 'rerun', ticket: 'AIRO-42', surface: null,
    };
    expect(parse(`${routeHref(route)}&unused=1#other`)).toMatchObject({ ...route, view: 'plugin', pluginPage: RUNS_PAGE_ID });
    expect(routeHref(parse(`${routeHref(route)}&unused=1#other`))).toBe(routeHref(route));
  });
});

describe('Helm legacy panel links', () => {
  it.each(['underway', 'newrun', 'backlog', 'running', 'repoprs', 'recent', 'activity', 'shipped'])('retains %s with a contribution fallback across serialization', pane => {
    const route = parse(`/helm?repo=org/a&pane=${pane}`);
    expect(route).toMatchObject({ view: 'plugin', pane, panelInstance: pane, panelContribution: `helmsman.${pane}/panel` });
    expect(parse(routeHref(route))).toEqual(route);
    expect(routeHref(route)).not.toContain('panel=');
  });
  it('maps the retired personal PR pane to repository PRs', () => {
    expect(parse('/helm?pane=myprs')).toMatchObject({ pane: 'repoprs', panelInstance: 'repoprs', panelContribution: 'helmsman.repoprs/panel' });
  });
  it('retains a normalized legacy ticket as a launch-panel hint', () => {
    const route = parse('/helm?ticket=task-42');
    expect(route).toMatchObject({ ticket: 'TASK-42', pane: 'newrun', panelInstance: 'newrun', panelContribution: 'helmsman.newrun/panel' });
    expect(parse(routeHref(route))).toEqual(route);
    expect(parse('/helm?ticket=bad').panelInstance).toBeUndefined();
  });
  it('keeps explicit instance selection authoritative', () => {
    const route = parse('/helm?pane=newrun&ticket=TASK-42&panel=saved-panel');
    expect(route).toMatchObject({ panelInstance: 'saved-panel', ticket: 'TASK-42' });
    expect(route.panelContribution).toBeUndefined();
    expect(parse(routeHref(route))).toEqual(route);
  });
  it.each(['/helm', '/plugins/example.unavailable/page'])('preserves namespaced state without an instance locator at %s', path => {
    const state = JSON.stringify({ 'example.unavailable/panel': { version: 2, value: { draft: 'keep' } } });
    const route = parse(`${path}?panelState=${encodeURIComponent(state)}`);
    expect(route.panelState).toBe(state);
    expect(route.panelInstance).toBeUndefined();
    expect(parse(routeHref(route))).toEqual(route);
  });
});

describe('authored clarification alias', () => {
  it('resolves the authored page with header scope and exact panel state across serialization', () => {
    const cleanup = appPages.register(clarificationsManifest);
    try {
      const panelState = JSON.stringify({ 'helmsman.clarifications/panel': { version: 1, value: { question: 'q' } } });
      const route = parse(`/clarifications?repo=org/a&panel=missing&panelState=${encodeURIComponent(panelState)}`);
      expect(route).toMatchObject({ view: 'plugin', pluginPage: CLARIFICATIONS_PAGE_ID, pluginSlot: CLARIFICATIONS_PAGE_SLOT, repo: 'org/a', panelInstance: 'missing', panelState });
      expect(parse(routeHref({ ...route, repo: 'org/b' }))).toEqual({ ...route, repo: 'org/b' });
    } finally { cleanup(); }
  });
  it('retains unavailable selection without falling back to the compatibility page', () => {
    appPages.select(CLARIFICATIONS_PAGE_SLOT, 'example.missing/page');
    const cleanup = appPages.register(compatibilityClarificationsManifest);
    try {
      expect(parse('/clarifications?repo=org/a')).toMatchObject({ view: 'plugin', pluginPage: 'example.missing/page', pluginSlot: CLARIFICATIONS_PAGE_SLOT, repo: 'org/a' });
      expect(appPages.resolvePath('/clarifications')?.page).toBeNull();
      const recovery = parse('/plugins/helmsman.compat-clarifications/page?repo=org/a');
      expect(recovery).toMatchObject({ view: 'plugin', pluginPage: 'helmsman.compat-clarifications/page', repo: 'org/a' });
      expect(recovery.pluginSlot).toBeUndefined(); expect(routeHref(recovery)).toBe('/plugins/helmsman.compat-clarifications/page?repo=org%2Fa');
    } finally { appPages.select(CLARIFICATIONS_PAGE_SLOT, null); cleanup(); }
  });
});


describe('authored Runs alias', () => {
  it.each(['review', 'rerun'])('retains %s prefill with independent header, PR and run targets', mode => {
    const state = { 'example.extra/panel': { version: 2, value: { draft: 'keep' } } };
    const route = parse(`/runs?repo=org/header&prRepo=org/target&pr=42&pane=newrun&mode=${mode}&run=run-1&runRepo=org/run&ticket=task-7&panelState=${encodeURIComponent(JSON.stringify(state))}`);
    expect(route).toMatchObject({ view: 'plugin', pluginPage: RUNS_PAGE_ID, pluginSlot: RUNS_PAGE_SLOT,
      repo: 'org/header', prRepo: 'org/target', pr: 42, mode, run: 'run-1', runRepo: 'org/run', ticket: 'TASK-7',
      panelInstance: 'pull-request', panelContribution: 'helmsman.compat-pr/panel' });
    expect(JSON.parse(route.panelState!)).toEqual({ ...state,
      'helmsman.compat-pr/panel': { version: 1, value: { target: { repo: 'org/target', number: 42 }, mode } } });
    expect(parse(routeHref(route))).toEqual(route);
  });
  it.each(['', 'bad repo', 'owner/..'])('rejects malformed explicit PR targets without header fallback: %j', target => {
    const route = parse(`/runs?repo=org/header&prRepo=${encodeURIComponent(target)}&pr=42`);
    expect(route).toMatchObject({ repo: 'org/header', prRepo: null, pr: null });
    expect(route.panelState).toBeUndefined();
    expect(parse(routeHref(route))).toEqual(route);
  });
  it('resolves history focus and leaves the tasks pane to the shared viewer', () => {
    const history = parse('/runs?pane=recent&run=run-1&runRepo=org/run');
    expect(history).toMatchObject({ panelInstance: 'run-history', panelContribution: 'helmsman.run-history/panel' });
    expect(parse(routeHref(history))).toEqual(history);
    expect(parse('/runs?pane=tasks&prRepo=org/target&pr=42').panelInstance).toBeUndefined();
  });
  it('retains an explicit instance instead of inferring a contribution', () => {
    const route = parse('/runs?pane=newrun&prRepo=org/target&pr=42&panel=custom');
    expect(route.panelInstance).toBe('custom'); expect(route.panelContribution).toBeUndefined();
    expect(parse(routeHref(route))).toEqual(route);
  });
  it('supports the canonical contribution and compatible replacement without legacy fallback', () => {
    const cleanup = appPages.register(runsManifest);
    const replacement = { ...runsManifest, id: 'example.runs' };
    const removeReplacement = appPages.register(replacement);
    try {
      const canonical = parse(`/plugins/${RUNS_PAGE_ID}?pane=recent`);
      expect(canonical).toMatchObject({ view: 'plugin', pluginPage: RUNS_PAGE_ID, panelInstance: 'run-history' });
      expect(parse(routeHref(canonical))).toEqual(canonical);
      appPages.select(RUNS_PAGE_SLOT, 'example.runs/page');
      const selected = parse('/runs?prRepo=org/target&pr=42&mode=review');
      expect(selected).toMatchObject({ view: 'plugin', pluginPage: 'example.runs/page', panelInstance: 'pull-request' });
      expect(parse(routeHref(selected))).toEqual(selected);
      removeReplacement();
      expect(parse('/runs')).toMatchObject({ view: 'plugin', pluginPage: 'example.runs/page' });
      expect(appPages.resolvePath('/runs')?.page).toBeNull();
    } finally { appPages.select(RUNS_PAGE_SLOT, null); removeReplacement(); cleanup(); }
  });
});

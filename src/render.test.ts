import { term } from './logic/terminology';
import type { PrInboxState } from './data/prLists';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_HELP, renderCmuxView, renderConfigView, renderAppShell, renderPrPanel, renderPrView, renderRepoPrs, renderRunsDrawer, renderVoyage, runTabStatus } from './render';
import { EDITABLE_KEYS } from '../server/helmsman/config-store';
import type { CmuxViewState, RunTabView } from './render';
import type { UiConfig } from './data/config';
import type { PrStatusView } from './data/pr';
import type { CmuxTabView } from './logic/cmuxPanel';
import { DEFAULT_THEME_ID, THEMES } from './data/themes';
import { appPages, TODOS_PAGE_SLOT, TODOS_PAGE_ID, TRIAGE_PAGE_SLOT, TRIAGE_PAGE_ID, BUGS_PAGE_SLOT, BUGS_PAGE_ID } from './plugins/builtins';

const NOW: Date = new Date('2026-08-17T12:00:00.000Z');

function root(): HTMLDivElement {
  document.body.innerHTML = '<div id="app"></div>';
  const el: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
  if (!el) throw new Error('missing #app');
  return el;
}

describe('application views', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['todos', TODOS_PAGE_SLOT, TODOS_PAGE_ID], ['triage', TRIAGE_PAGE_SLOT, TRIAGE_PAGE_ID], ['bugs', BUGS_PAGE_SLOT, BUGS_PAGE_ID],
  ])('highlights the original %s tab for plugin aliases and unavailable replacements', (view, slot, id) => {
    const el = root();
    for (const selected of [id, 'example.unavailable/page']) {
      appPages.select(slot, selected);
      try {
        el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: slot, pluginPage: selected, repos: ['org/a'], selectedRepo: 'org/a', themeId: DEFAULT_THEME_ID, readout: null }, '');
        expect(el.querySelectorAll('.page-tab.is-active')).toHaveLength(1);
        expect(el.querySelector('.page-tab.is-active')?.id).toBe(`page-tab-${view}`);
        expect(el.querySelector('#page-tab-plugin')).toBeNull();
      } finally { appPages.select(slot, null); }
    }
  });

  it.each([false, true])('keeps a scoped Source settings link when core config unavailable is %s', unavailable => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: ['org/a'], selectedRepo: 'org/a', themeId: DEFAULT_THEME_ID, unavailable });
    expect(el.querySelector('a[href="/source-settings?repo=org%2Fa"]')?.textContent).toBe('Source settings');
    expect(el.querySelector('[data-task-source-settings]')).toBeNull();
    expect(el.querySelector('.ui-customization-panel')).not.toBeNull();
  });

  it('renders theme selection in its own Config customization panel', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'dracula' });
    const select: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.theme-select');
    expect(select).not.toBeNull();
    expect(el.querySelector('.ui-customization-panel .theme-select')).toBe(select);
    expect(el.querySelector('.ui-customization-panel .theme-preview')).not.toBeNull();
    expect(el.querySelector('.helm-head .theme-select')).toBeNull();
    expect(el.querySelector('label[for="ui-theme"]')?.textContent).toBe('Theme');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(THEMES.map((t) => t.id));
    expect(select!.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('dracula');
  });

  it('omits theme selection from the dashboard', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: 'helmsman/helm-page', repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID, readout: null }, '<h1 class="sr-only">Helm</h1>');
    expect(el.querySelector('.theme-select')).toBeNull();
  });

  it('adds a help tooltip to each config key', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = { config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] };
    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const hint: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"] .config-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('title')).toContain('claude-code');
    expect(hint?.getAttribute('aria-label')).toBe(hint?.getAttribute('title'));
  });

  it('has help text with an example for every editable config key', () => {
    for (const key of EDITABLE_KEYS) {
      expect(CONFIG_HELP[key]?.length ?? 0, `missing tooltip for ${key}`).toBeGreaterThan(0);
      expect(CONFIG_HELP[key] ?? '', `missing example for ${key}`).toContain('Example:');
    }
  });

  it('renders a config row per key, marks overridden keys, and never renders a secret value', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = {
      config: { AGENT_ADAPTER: 'claude-code', AGENT_MAX_ATTEMPTS: 1 },
      overridden: ['AGENT_MAX_ATTEMPTS'],
      jiraTokenSet: true,
    };

    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });

    const rows: NodeListOf<HTMLElement> = el.querySelectorAll<HTMLElement>('.config-panel:not(.pre-pr-config-panel) .config-row:not(.config-secret-row)');
    expect(rows.length).toBe(10);
    const adapterRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
    expect(adapterRow).not.toBeNull();
    expect(adapterRow!.querySelector<HTMLInputElement>('.config-input')?.value).toBe('claude-code');
    const attemptsRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"]');
    expect(attemptsRow).not.toBeNull();
    expect(attemptsRow!.textContent).toContain('saved override');
    expect(adapterRow!.textContent).not.toContain('saved override');
  });

  it('groups pre-PR settings in one panel with bounded numeric inputs and defaults', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const panel = el.querySelector('.pre-pr-config-panel');
    expect(panel?.textContent).toContain(`active ${term('runs').toLowerCase()} keep their settings`);
    expect(panel?.textContent).toContain('With only one installed, one reviewer runs');
    for (const [key, value, min, max] of [
      ['PRE_PR_REVIEWER_COUNT', '2', '1', '2'],
      ['PRE_PR_MAX_ROUNDS', '3', '1', '5'],
      ['PRE_PR_STAGE_TIMEOUT_MINUTES', '45', '5', '180'],
    ]) {
      const row = panel?.querySelector(`.config-row[data-key="${key}"]`);
      const input = row?.querySelector<HTMLInputElement>('.config-input');
      expect(input?.type).toBe('number');
      expect(input?.value).toBe(value);
      expect(input?.min).toBe(min);
      expect(input?.max).toBe(max);
      expect(input?.step).toBe('1');
      expect(input?.required).toBe(true);
      expect(row?.querySelector('label')?.getAttribute('for')).toBe(input?.id);
      const descriptions = input?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
      expect(descriptions.map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain(key);
      expect(descriptions).toContain(`error-${key}`);
      expect(row?.querySelector('.config-save')?.getAttribute('data-key')).toBe(key);
    }
  });

  it('shows persisted pre-PR settings only once and marks overrides', () => {
    const el = root();
    el.innerHTML = renderConfigView({
      config: { PRE_PR_REVIEWER_COUNT: 1, PRE_PR_MAX_ROUNDS: 5, PRE_PR_STAGE_TIMEOUT_MINUTES: 90 },
      overridden: ['PRE_PR_MAX_ROUNDS'],
    }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    for (const [key, value] of [
      ['PRE_PR_REVIEWER_COUNT', '1'], ['PRE_PR_MAX_ROUNDS', '5'], ['PRE_PR_STAGE_TIMEOUT_MINUTES', '90'],
    ]) {
      expect(el.querySelectorAll(`.config-row[data-key="${key}"]`)).toHaveLength(1);
      expect(el.querySelector<HTMLInputElement>(`.pre-pr-config-panel [data-key="${key}"] .config-input`)?.value).toBe(value);
    }
    expect(el.querySelector('.pre-pr-config-panel [data-key="PRE_PR_MAX_ROUNDS"] .config-overridden')).not.toBeNull();
    expect(el.querySelector('.pre-pr-config-panel [data-key="PRE_PR_REVIEWER_COUNT"] .config-overridden')).toBeNull();
  });

  it('renders a write-only JIRA_API_TOKEN update row that never carries a value', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = { config: { AGENT_ADAPTER: 'claude-code' }, overridden: [], jiraTokenSet: true };
    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const tokenRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-secret-row[data-key="JIRA_API_TOKEN"]');
    expect(tokenRow).not.toBeNull();
    const input: HTMLInputElement | null = tokenRow!.querySelector<HTMLInputElement>('.config-secret-input');
    expect(input!.type).toBe('password');
    expect(input!.value).toBe('');
    expect(tokenRow!.querySelector('.config-save')?.getAttribute('data-key')).toBe('JIRA_API_TOKEN');
    expect(tokenRow!.textContent).toContain('set ✓');
  });

  it('shows the Jira token as not set when absent', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [], jiraTokenSet: false }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    expect(el.querySelector('.config-secret-row .config-secret-status')?.textContent).toContain('not set');
  });

  it('renders the PR lookup panel in the PR view, not the dashboard', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: 'helmsman/helm-page', repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID, readout: null }, '<h1 class="sr-only">Helm</h1>');
    expect(el.querySelector('.pr-lookup-input')).toBeNull();
    el.innerHTML = renderPrView(
      { repo: null, number: null, pr: null, diff: null, loading: false },
      { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID },
    );
    expect(el.querySelector('.pr-lookup-input')).not.toBeNull();
    expect(el.querySelector('.pr-lookup-go')).not.toBeNull();
    expect(el.querySelector('.pr-lookup-result')).not.toBeNull();
    expect(el.querySelector('.page-tab.is-active')?.getAttribute('data-view')).toBe('prs');
  });
});

function prFixture(over: Partial<PrStatusView> = {}): PrStatusView {
  return {
    number: 42,
    repo: 'org/alpha',
    state: 'open',
    draft: false,
    merged: false,
    headRefName: 'feature-branch',
    reviewDecision: 'REVIEW_REQUIRED',
    comments: 3,
    checks: { passed: 2, failed: 0, pending: 1 },
    reviews: { requested: 0, approved: 0, changesRequested: 0, commented: 0 },
    url: 'https://github.com/org/alpha/pull/42',
    ...over,
  };
}

describe('renderPrPanel', () => {
  function mount(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }

  it('shows personal review and activity timestamps with exact local times', () => {
    const el = mount(renderPrPanel(prFixture({
      viewerReviewedAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T12:00:00Z',
      headSha: 'new-commit', viewerReviewedCommitId: 'reviewed-commit',
    }), false));
    expect(el.querySelector('.pr-last-reviewed')?.textContent).toContain(term('lastReviewed'));
    expect(el.querySelector('.pr-last-reviewed time')?.getAttribute('datetime')).toBe('2026-09-17T10:00:00.000Z');
    expect(el.querySelector('.pr-last-updated time')?.getAttribute('datetime')).toBe('2026-09-17T12:00:00.000Z');
    expect(el.querySelector('.pr-last-reviewed time')?.getAttribute('title')).toBeTruthy();
    expect(el.querySelector('.pr-review-freshness')?.textContent).toBe('New commits since your review');
  });

  it('does not call later PR activity new commits when the reviewed commit matches', () => {
    const el = mount(renderPrPanel(prFixture({
      viewerReviewedAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T12:00:00Z',
      headSha: 'same-commit', viewerReviewedCommitId: 'same-commit',
    }), false));
    expect(el.querySelector('.pr-review-freshness')?.textContent).toBe('You reviewed the current commit');
    expect(el.querySelector('.pr-review-freshness.chip-review')).toBeNull();
  });

  it.each([
    { reviewsAvailable: true, viewerReview: null, expected: 'Not inspected yet' },
    { reviewsAvailable: false, viewerReview: null, expected: 'Unavailable' },
    { reviewsAvailable: true, viewerReview: 'COMMENTED', expected: 'Unavailable' },
    { reviewsAvailable: undefined, viewerReview: null, expected: 'Unavailable' },
  ] as const)('distinguishes unreviewed PRs from unavailable review dates: %j', ({ expected, ...fields }) => {
    const el = mount(renderPrPanel(prFixture(fields), false));
    expect(el.querySelector('.pr-last-reviewed')?.textContent).toContain(expected);
    expect(el.querySelector('.pr-review-freshness')).toBeNull();
  });

  it.each([null, 42, {}, 'bad-date', '<img src=x onerror=alert(1)>'])('handles invalid timestamps safely: %j', (value) => {
    const el = mount(renderPrPanel(prFixture({
      viewerReviewedAt: value, updatedAt: value, reviewsAvailable: true,
      headSha: 'new-commit', viewerReviewedCommitId: 'reviewed-commit',
    } as unknown as Partial<PrStatusView>), false));
    expect(el.querySelectorAll('.pr-panel-timing time, .pr-panel-timing img')).toHaveLength(0);
    expect(el.querySelector('.pr-last-reviewed')?.textContent).toContain('Unavailable');
    expect(el.querySelector('.pr-last-updated')?.textContent).toContain('Unavailable');
    expect(el.querySelector('.pr-review-freshness')).toBeNull();
  });

  it('does not infer commit changes from timestamps when review commit data is missing', () => {
    const el = mount(renderPrPanel(prFixture({ viewerReviewedAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T12:00:00Z' }), false));
    expect(el.querySelector('.pr-review-freshness')).toBeNull();
  });

  it('hides stale review dates when reviews are unavailable', () => {
    const el = mount(renderPrPanel(prFixture({ reviewsAvailable: false, viewerReviewedAt: '2026-09-17T10:00:00Z', headSha: 'new', viewerReviewedCommitId: 'old' }), false));
    expect(el.querySelector('.pr-last-reviewed')?.textContent).toContain('Unavailable');
    expect(el.querySelector('.pr-review-freshness')).toBeNull();
  });

  it('renders the state chip, CI summary, review controls, and PR link for an open PR', () => {
    const html: string = renderPrPanel(prFixture(), false);
    expect(html).toContain('Open');
    expect(html).toContain('2');
    expect(html).toContain('pr-approve');
    expect(html).toContain('pr-request-changes');
    expect(html).toContain('pr-comment');
    expect(html).toContain('pr-review-body');
    expect(html).toContain('https://github.com/org/alpha/pull/42');
    expect(html).toContain('#42');
  });

  it('omits the rerun control when canRerun is false', () => {
    const html: string = renderPrPanel(prFixture(), false);
    expect(html).not.toContain('pr-rerun-feedback');
    expect(html).not.toContain('class="pr-rerun"');
    expect(html).not.toContain('pr-review-agent');
  });

  it('includes the rerun control only for an owned local PR', () => {
    const html: string = renderPrPanel(prFixture({ isOwnPr: true }), true);
    expect(html).toContain('pr-rerun-feedback');
    expect(html).toContain('pr-rerun');
  });

  it('includes the code-review-with-agent button when canRerun is true', () => {
    const html: string = renderPrPanel(prFixture(), true);
    expect(html).toContain('pr-review-agent');
    expect(html).toContain(term('codeReview'));
  });

  it('includes model + effort selectors on the review/rerun controls', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderPrPanel(prFixture(), true);
    expect(el.querySelector('.pr-model')).not.toBeNull();
    expect(el.querySelector('.pr-effort')).not.toBeNull();
    expect(el.querySelector<HTMLSelectElement>('.pr-model')?.value).toBe('');
    expect(el.querySelector<HTMLSelectElement>('.pr-effort')?.value).toBe('');
    expect(el.querySelector('.pr-model option[selected]')?.textContent).toBe('Automatic by complexity');
    expect(Array.from(el.querySelectorAll<HTMLOptionElement>('.pr-effort option')).map((o) => o.value))
      .toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each([false, undefined])('hides relaunch for ownership %s while retaining local crew review', (isOwnPr) => {
    const el = mount(renderPrPanel(prFixture({ isOwnPr }), true));
    expect(el.querySelector('.pr-rerun-feedback')).toBeNull();
    expect(el.querySelector('.pr-rerun')).toBeNull();
    expect(el.querySelector('a[href*="mode=rerun"]')).toBeNull();
    expect(el.querySelector('.pr-review-agent')).not.toBeNull();
    expect(el.querySelector('.pr-model')).not.toBeNull();
    expect(el.querySelector('.pr-effort')).not.toBeNull();
    expect(el.querySelector('a[href*="mode=review"]')).not.toBeNull();
  });

  it('hides crew actions for an owned PR outside local repositories', () => {
    const el = mount(renderPrPanel(prFixture({ isOwnPr: true }), false));
    expect(el.querySelector('.pr-rerun-feedback')).toBeNull();
    expect(el.querySelector('.pr-rerun')).toBeNull();
    expect(el.querySelector('.pr-review-agent')).toBeNull();
    expect(el.querySelector('a[href*="mode=rerun"]')).toBeNull();
  });

  it('groups PR identity, statuses, and metadata without duplicate reviewer tallies', () => {
    const el = mount(renderPrPanel(prFixture({
      title: 'Fix image targeting', authorLogin: 'octocat',
      reviews: { requested: 2, approved: 3, changesRequested: 1, commented: 4 },
    }), false));
    expect(el.querySelector('.pr-panel-identity')?.textContent).toContain('Fix image targeting');
    expect(el.querySelector('.pr-panel-identity')?.textContent).toContain('org/alpha #42');
    expect(el.querySelector('.pr-panel-identity')?.textContent).toContain('by octocat');
    expect(el.querySelector('.pr-panel-status')?.textContent).toContain('3/2 approvals');
    expect(el.querySelector('.pr-panel-context .pr-branch')?.textContent).toContain('feature-branch');
    expect(el.querySelector('.pr-panel-context .pr-ci')?.getAttribute('aria-label')).toBe('Checks: 2 passed, 0 failed, 1 pending');
    expect(el.querySelector('.pr-reviewers')).toBeNull();
  });

  it.each([
    ['APPROVED', 'Approved'], ['CHANGES_REQUESTED', 'Changes requested'],
    ['COMMENTED', 'Commented'], ['DISMISSED', 'Dismissed'],
  ] as const)('shows the viewer review %s distinctly in the header', (viewerReview, label) => {
    const el = mount(renderPrPanel(prFixture({ viewerReview }), false));
    expect(el.querySelector('.pr-panel-head .pr-viewer-review')?.textContent).toBe(`Your ${term('review').toLowerCase()}: ${label}`);
    expect(el.querySelector('.pr-approval-progress')?.textContent).toBe('0/2 approvals · 2 needed');
    const matching = mount(renderPrPanel(prFixture({ viewerReview, reviewDecision: viewerReview }), false));
    expect(matching.querySelector('.pr-viewer-review')?.textContent).toBe(`Your ${term('review').toLowerCase()}: ${label}`);
    expect(matching.querySelector('.pr-approval-progress')?.textContent).toBe('0/2 approvals · 2 needed');
  });

  it.each([null, undefined])('omits the personal review badge when review is %s', (viewerReview) => {
    const el = mount(renderPrPanel(prFixture({ viewerReview }), false));
    expect(el.querySelector('.pr-viewer-review')).toBeNull();
    expect(el.querySelector('.pr-panel-title')).toBeNull();
    expect(el.querySelector('.pr-author')).toBeNull();
  });

  it('ignores malformed optional identity and review values', () => {
    const pr = prFixture({ title: 42, authorLogin: {}, viewerReview: 'constructor' } as unknown as Partial<PrStatusView>);
    const el = mount(renderPrPanel(pr, false));
    expect(el.querySelector('.pr-panel-title')).toBeNull();
    expect(el.querySelector('.pr-author')).toBeNull();
    expect(el.querySelector('.pr-viewer-review')).toBeNull();
  });

  it('renders a not-found note when there is no PR', () => {
    const html: string = renderPrPanel(null, false);
    expect(html).toContain('empty-note');
    expect(html.toLowerCase()).toContain(term('noPrFound').toLowerCase());
    const el = root();
    el.innerHTML = html;
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Check the URL and your GitHub access');
  });

  it('escapes a malicious headRefName and url', () => {
    const payload: string = '<img src=x onerror=alert(1)>';
    const html: string = renderPrPanel(prFixture({ title: payload, authorLogin: payload, headRefName: payload, url: payload }), false);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

function cmuxTabFixture(over: Partial<CmuxTabView> = {}): CmuxTabView {
  return {
    windowRef: 'win-1',
    workspaceRef: 'ws-1',
    workspaceTitle: 'helmsman',
    surfaceRef: 'surface-1',
    surfaceTitle: 'main',
    type: 'shell',
    cwd: '/repo',
    selected: false,
    ...over,
  };
}

function cmuxStateFixture(over: Partial<CmuxViewState> = {}): CmuxViewState {
  return {
    connected: true,
    tabs: [cmuxTabFixture()],
    selectedSurface: null,
    screen: '',
    isCapturing: false,
    repos: [],
    selectedRepo: null,
    themeId: DEFAULT_THEME_ID,
    ...over,
  };
}

describe('renderCmuxView', () => {
  it('renders a not-connected note and no tab list when disconnected', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ connected: false, tabs: [cmuxTabFixture()] }));
    expect(html.toLowerCase()).toContain('not connected');
    expect(html).not.toContain('cmux-tab"');
  });

  it('renders the tab list with title and workspace/type meta', () => {
    const html: string = renderCmuxView(cmuxStateFixture());
    expect(html).toContain('data-surface="surface-1"');
    expect(html).toContain('main');
    expect(html).toContain('helmsman');
    expect(html).toContain('shell');
  });

  it('marks the selected tab and shows a prompt to select one when nothing is selected', () => {
    const html: string = renderCmuxView(cmuxStateFixture());
    expect(html).toContain('Select a tab');
    expect(html).not.toContain('is-selected');
  });

  it('shows the screen, send form, and only universal actions for a non-agent tab when selected', () => {
    const html: string = renderCmuxView(
      cmuxStateFixture({ selectedSurface: 'surface-1', screen: 'hello world' }),
    );
    expect(html).toContain('is-selected');
    expect(html).toContain('cmux-screen');
    expect(html).toContain('hello world');
    expect(html).toContain('cmux-send');
    expect(html).toContain('data-action="enter"');
    expect(html).toContain('data-action="escape"');
    expect(html).toContain('data-action="interrupt"');
    expect(html).not.toContain('data-action="continue"');
    expect(html).not.toContain('data-action="stop"');
    expect(html).not.toContain('data-action="approve"');
  });

  it('adds agent actions when the selected tab is an agent-session', () => {
    const html: string = renderCmuxView(
      cmuxStateFixture({
        tabs: [cmuxTabFixture({ surfaceRef: 'agent-1', type: 'agent-session' })],
        selectedSurface: 'agent-1',
        screen: '',
      }),
    );
    expect(html).toContain('data-action="continue"');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('data-action="approve"');
  });

  it('escapes malicious tab titles and screen content', () => {
    const payload: string = '<img src=x onerror=alert(1)>';
    const html: string = renderCmuxView(
      cmuxStateFixture({
        tabs: [cmuxTabFixture({ surfaceTitle: payload })],
        selectedSurface: 'surface-1',
        screen: payload,
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders a no-tabs note when the tab list is empty', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ tabs: [] }));
    expect(html.toLowerCase()).toContain('no terminal tabs');
  });

  it('gives the list and detail panels collapse buttons with stable ids', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1' }));
    expect(html).toContain('data-collapse-id="cmux:list"');
    expect(html).toContain('data-collapse-id="cmux:detail"');
  });

  it('marks a cmux panel collapsed when its id is in the set', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', collapsed: new Set(['cmux:list']) }));
    expect(el.querySelector('.cmux-list.is-collapsed')).not.toBeNull();
    expect(el.querySelector('.cmux-detail.is-collapsed')).toBeNull();
  });
});

describe('renderRunsDrawer', () => {
  const tab = (over: Partial<RunTabView> = {}): RunTabView => ({
    id: 'run-1',
    label: 'TICK-1 — thing',
    complete: false,
    ...over,
  });

  it('renders a tab per run with select and close controls', () => {
    const html: string = renderRunsDrawer([tab({ id: 'a', label: 'A' }), tab({ id: 'b', label: 'B' })], 'a');
    expect(html).toContain('data-tabid="a"');
    expect(html).toContain('data-tabid="b"');
    expect((html.match(/run-tab-close/g) ?? []).length).toBe(2);
    expect((html.match(/run-tab-select/g) ?? []).length).toBe(2);
  });

  it('marks the active tab', () => {
    const el = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab({ id: 'a' }), tab({ id: 'b' })], 'b');
    expect(el.querySelector('.run-tab[data-tabid="b"]')?.classList.contains('is-active')).toBe(true);
    const active = el.querySelector<HTMLButtonElement>('.run-tab-select[data-tabid="b"]');
    expect(active?.getAttribute('role')).toBe('tab');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.tabIndex).toBe(0);
    expect(el.querySelector<HTMLButtonElement>('.run-tab-select[data-tabid="a"]')?.tabIndex).toBe(-1);
    expect(el.querySelector('.run-drawer-body')?.getAttribute('aria-labelledby')).toBe(active?.id);
  });

  it('shows an unknown completed result neutrally instead of implying success', () => {
    const el = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab({ complete: true })], 'run-1');
    expect(el.querySelector('.run-tab')?.getAttribute('data-run-status')).toBe('completed');
    expect(el.querySelector('.run-tab-status')?.textContent).toBe('Completed');
    expect(el.querySelector('.run-tab-dot')).toBeNull();
  });

  it.each([
    ['failed', term('failed')], ['succeeded', term('success')], ['running', term('running')], ['stopped', 'Stopped'], ['queued', 'Queued'],
  ])('labels %s with its own status for theme colors', (status, label) => {
    const el = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab({ status, complete: true })], 'run-1');
    expect(el.querySelector('.run-tab')?.getAttribute('data-run-status')).toBe(status);
    expect(el.querySelector('.run-tab-status')?.textContent).toBe(label);
    expect(runTabStatus(status, true)).toEqual({ kind: status, label });
  });

  it('keeps copy, select, open, and close controls separate', () => {
    const el = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab()], 'run-1');
    const card = el.querySelector('.run-tab')!;
    expect(card.querySelectorAll('button button, a button, button a')).toHaveLength(0);
    expect(card.querySelector('.run-tab-select [data-copy-run-id]')).toBeNull();
    expect(card.querySelector('[data-copy-run-id]')?.getAttribute('aria-label')).toBe('Copy full voyage ID run-1');
    expect(card.querySelector('[data-copy-run-id] .voyage-copy-feedback')?.getAttribute('role')).toBe('status');
    expect(card.querySelector('.run-tab-open')?.getAttribute('aria-label')).toContain('Open');
    expect(card.querySelector('.run-tab-close')?.getAttribute('aria-label')).toContain('Close');
  });

  it('renders a separate full-ID copy button outside history navigation', () => {
    const el = document.createElement('div');
    const id = 'b5fcda70-6766-461d-a828-bd1fe233a580';
    el.innerHTML = renderVoyage({ id, ticketId: 'T-1', repo: 'org/repo', status: 'succeeded', attempt: 1, prNumber: null, startedAt: '2026-09-18T00:00:00Z', costUsd: null });
    expect(el.querySelector('.runs-voyage-link [data-copy-run-id]')).toBeNull();
    expect(el.querySelector('.recent-run .voyage-row-meta > [data-copy-run-id]')?.getAttribute('data-copy-run-id')).toBe(id);
    expect(el.querySelector('.voyage-id')?.textContent).toBe('b5fcda706766');
  });

  it.each(['failed', 'running', 'queued', 'succeeded', 'stopped'])('offers a separate Retry button only for failed history voyages: %s', status => {
    const el = document.createElement('div');
    const id = 'b5fcda70-6766-461d-a828-bd1fe233a580';
    el.innerHTML = renderVoyage({ id, ticketId: 'Freeform', repo: 'org/repo', status, attempt: 1, prNumber: null, startedAt: NOW.toISOString(), costUsd: null });
    const retry = el.querySelector<HTMLButtonElement>('[data-retry-run-id]');
    expect(!!retry).toBe(status === 'failed');
    if (status === 'failed') {
      expect(retry?.dataset.retryRunId).toBe(id);
      expect(retry?.type).toBe('button');
      expect(retry?.querySelector('.sr-only')?.textContent).toBe('Retry');
      expect(retry?.querySelector('svg')).not.toBeNull();
      expect(retry?.getAttribute('aria-label')).toBe(`${term('retryRun')} ${id}`);
      expect(el.querySelector('[data-retry-feedback-for]')?.getAttribute('data-retry-feedback-for')).toBe(id);
      expect(el.querySelector('[data-retry-feedback-for]')?.getAttribute('aria-live')).toBe('polite');
    }
    expect(el.querySelectorAll('a button, button button, button a')).toHaveLength(0);
  });

  it('shows Retry in a persistent drawer slot only for the active failed voyage', () => {
    const el = document.createElement('div');
    const tabs = [tab({ id: 'failed-run', status: 'failed', complete: true }), tab({ id: 'running-run', status: 'running' })];
    el.innerHTML = renderRunsDrawer(tabs, 'failed-run');
    expect(el.querySelectorAll('[data-retry-run-id]')).toHaveLength(1);
    expect(el.querySelector('.run-drawer-retry [data-retry-run-id]')?.getAttribute('data-retry-run-id')).toBe('failed-run');
    expect(el.querySelector('.run-drawer-retry [data-retry-run-id]')?.textContent).toBe('Retry');
    expect(el.querySelector('.run-drawer-retry [data-retry-run-id] .sr-only')).toBeNull();
    expect(el.querySelector('.run-drawer-retry')?.nextElementSibling?.classList.contains('run-drawer-body')).toBe(true);
    expect(el.querySelectorAll('a button, button button, button a')).toHaveLength(0);
    el.innerHTML = renderRunsDrawer(tabs, 'running-run');
    expect(el.querySelector('[data-retry-run-id]')).toBeNull();
    expect(el.querySelector('.run-drawer-retry')?.innerHTML).toBe('');
  });

  it.each(['err-launch', '', 'invalid/id', 'x'.repeat(129)])('omits Retry for synthetic or invalid failed voyage IDs: %s', id => {
    const el = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab({ id, status: 'failed', complete: true })], id);
    expect(el.querySelector('[data-retry-run-id]')).toBeNull();
    el.innerHTML = renderVoyage({ id, ticketId: 'Task', repo: 'org/repo', status: 'failed', attempt: 1, prNumber: null, startedAt: NOW.toISOString(), costUsd: null });
    expect(el.querySelector('[data-retry-run-id]')).toBeNull();
  });

  it('provides body, footer, and pr shells', () => {
    const html: string = renderRunsDrawer([tab()], 'run-1');
    expect(html).toContain('run-drawer-body');
    expect(html).toContain('run-drawer-footer');
    expect(html).toContain('run-drawer-pr');
    expect(html).toContain('href="/api/agents/run-1/log/download"');
    expect(html).toContain('Download full log');
  });

  it('shows the same short ID in the tab and log toolbar while preserving full links', () => {
    const id = 'b5fcda70-6766-461d-a828-bd1fe233a580';
    const el = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab({ id })], id);
    for (const selector of ['.run-tab .voyage-id', '.run-log-toolbar .voyage-id']) {
      expect(el.querySelector(selector)?.textContent).toBe('b5fcda706766');
      expect(el.querySelector(selector)?.getAttribute('title')).toBe(id);
      expect(el.querySelector(selector)?.getAttribute('data-copy-run-id')).toBe(id);
    }
    expect(el.querySelector('.run-tab')?.getAttribute('data-tabid')).toBe(id);
    expect(el.querySelector('.run-log-download')?.getAttribute('href')).toBe(`/api/agents/${id}/log/download`);
  });

  it('escapes malicious labels', () => {
    const html: string = renderRunsDrawer([tab({ label: '<img src=x onerror=alert(1)>' })], 'run-1');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('shows an empty-state placeholder when there are no tabs', () => {
    const html: string = renderRunsDrawer([], null);
    expect(html).toContain('run-drawer-empty');
    expect(html).toContain('run-drawer-title');
    expect(html).not.toContain('run-tab-close');
    expect(html).not.toContain('run-log-download');
  });

  it('shows a drawer collapse button when tabs exist, none when empty', () => {
    expect(renderRunsDrawer([tab()], 'run-1')).toContain('data-collapse-id="runs:drawer"');
    expect(renderRunsDrawer([], null)).not.toContain('data-collapse-id="runs:drawer"');
  });

  it('reflects collapsed state on the drawer button', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab()], 'run-1', true);
    expect(el.querySelector('.surface-collapse')!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('repository PR body', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the same scoped repository body for background panel refreshes', () => {
    const state = { prs: [
      { number: 42, title: 'Selected repo', repo: 'org/alpha', reviewDecision: '', draft: false, createdAt: NOW.toISOString() },
      { number: 43, title: 'Other repo', repo: 'org/beta', reviewDecision: '', draft: false, createdAt: NOW.toISOString() },
    ], loading: false, degraded: false, truncated: false };
    const el: HTMLDivElement = root();
    el.innerHTML = renderRepoPrs('org/alpha', state);
    expect(el.querySelectorAll('.pr-list-row')).toHaveLength(1);
    expect(el.textContent).toContain('Selected repo');
    expect(el.textContent).not.toContain('Other repo');
    el.innerHTML = renderRepoPrs(null, state);
    expect(el.querySelector('.pr-list-row')).toBeNull();
    expect(el.textContent).toContain('Select a galleon');
  });
});

describe('renderPrView + renderPrDiff', () => {
  function mount(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }
  const opts = { repos: ['org/alpha'], selectedRepo: null, themeId: DEFAULT_THEME_ID };
  const pr = {
    number: 42, repo: 'org/alpha', state: 'open', draft: false, merged: false,
    headRefName: 'feat/x', reviewDecision: 'REVIEW_REQUIRED', comments: 1,
    checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/alpha/pull/42',
  };

  it('renders the lookup form and marks the PR tab active', () => {
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, opts));
    expect(el.querySelector('.pr-lookup-input')).not.toBeNull();
    expect(el.querySelector('.page-tab.is-active')?.getAttribute('data-view')).toBe('prs');
    expect(el.querySelector('.pr-diff-panel')).toBeNull();
  });

  it('renders review requests and authored PRs above the lookup with accessible, escaped rows', () => {
    const title = '<img src=x onerror=alert(1)>';
    const item = { number: 7, title, repo: 'org/alpha', reviewDecision: '', draft: false, createdAt: NOW.toISOString() };
    const ready = { prs: [item], loading: false, degraded: false, truncated: false };
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      ...opts, lists: { reviewRequests: ready, authored: { ...ready, prs: [{ ...item, number: 8, title: 'My work' }] } },
    }));
    expect(el.querySelector('.pr-inbox-grid')?.nextElementSibling?.classList.contains('pr-recent-runs')).toBe(true);
    expect(el.querySelector('.pr-recent-runs')?.nextElementSibling?.classList.contains('pr-lookup-panel')).toBe(true);
    const review = el.querySelector<HTMLElement>('.pr-review-requests .pr-list-row');
    expect(review?.dataset.repo).toBe('org/alpha');
    expect(review?.dataset.number).toBe('7');
    expect(review?.getAttribute('role')).toBe('button');
    expect(review?.getAttribute('tabindex')).toBe('0');
    expect(review?.textContent).toContain(title);
    expect(review?.querySelector('img')).toBeNull();
    expect(review?.getAttribute('aria-label')).toContain(title);
    expect(el.querySelector('.pr-authored .pr-list-row')?.getAttribute('data-number')).toBe('8');
  });

  it('ignores malformed list rows and safely renders missing optional display values', () => {
    const malformed = { prs: [null, undefined, { number: 0, repo: 'org/alpha' }, { number: 5 }, { number: 6, repo: 'org/alpha' }], loading: false, degraded: false, truncated: false };
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      ...opts, lists: { reviewRequests: malformed, authored: { ...malformed, prs: null } } as unknown as PrInboxState,
    }));
    expect(el.querySelectorAll('.pr-review-requests .pr-list-row')).toHaveLength(1);
    expect(el.querySelector('.pr-review-requests .pr-list-row')?.textContent).toContain('Untitled pull request');
    expect(el.querySelector('.pr-authored')?.textContent).toContain(term('noAuthoredPrs'));
  });

  it('keeps independent loading, unavailable, and truncated messages per list', () => {
    const empty = { prs: [], loading: false, degraded: false, truncated: false };
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      ...opts, lists: { reviewRequests: { ...empty, degraded: true }, authored: { ...empty, loading: true, truncated: true } },
    }));
    expect(el.querySelector('.pr-review-requests')?.textContent).toContain('unavailable');
    expect(el.querySelector('.pr-review-requests')?.textContent).not.toContain('No PRs');
    expect(el.querySelector('.pr-authored')?.textContent).toContain(term('loadingPrs'));
    expect(el.querySelector('.pr-authored .pr-list')?.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('.pr-authored')?.textContent).toContain(term('morePrs'));
  });

  it('keeps usable PRs visible and explains incomplete results when another source fails', () => {
    const partial = { prs: [{ number: 7, title: 'Review this', repo: 'org/alpha', reviewDecision: '', draft: false, createdAt: NOW.toISOString() }], loading: false, degraded: true, truncated: false };
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      ...opts, lists: { reviewRequests: partial, authored: { ...partial, prs: [] } },
    }));
    expect(el.querySelectorAll('.pr-review-requests .pr-list-row')).toHaveLength(1);
    expect(el.querySelector('.pr-review-requests')?.textContent).toContain('Some GitHub results are unavailable. This list may be incomplete.');
    expect(el.querySelector('.pr-authored')?.textContent).toContain(term('unavailablePrs'));
  });

  it('does not claim there are no review requests when retrieved results are incomplete and links to GitHub', () => {
    const truncated = { prs: [], loading: false, degraded: false, truncated: true };
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      ...opts, lists: { reviewRequests: truncated, authored: truncated },
    }));
    const requests = el.querySelector('.pr-review-requests');
    expect(requests?.textContent).toContain(term('noMatchingPrs'));
    expect(requests?.textContent).not.toContain(term('noReviewRequests'));
    const link = requests?.querySelector<HTMLAnchorElement>('.pr-list-github');
    expect(link?.href).toBe('https://github.com/pulls/review-requested');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.closest('.pr-list-row')).toBeNull();
    expect(el.querySelector<HTMLAnchorElement>('.pr-authored .pr-list-github')?.href).toBe('https://github.com/pulls');
    const repo = mount(renderRepoPrs('org/alpha', truncated));
    expect(repo.querySelector<HTMLAnchorElement>('.pr-list-github')?.href).toBe('https://github.com/org/alpha/pulls');
    expect(repo.textContent).not.toContain(term('noRepoPrs'));
  });

  it('distinguishes empty review requests from empty authored PRs', () => {
    const empty = { prs: [], loading: false, degraded: false, truncated: false };
    const el = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      ...opts, lists: { reviewRequests: empty, authored: empty },
    }));
    expect(el.querySelector('.pr-review-requests')?.textContent).toContain(term('noReviewRequests'));
    expect(el.querySelector('.pr-authored')?.textContent).toContain(term('noAuthoredPrs'));
  });

  it('renders the PR panel and a per-file diff when loaded', () => {
    const diff = [
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new\n ctx' },
      { filename: 'img.png', status: 'added', additions: 0, deletions: 0, patch: null },
    ];
    const el = mount(renderPrView({ repo: 'org/alpha', number: 42, pr, diff, loading: false }, opts));
    expect(el.querySelector('.pr-lookup-result .pr-panel')).not.toBeNull();
    const files = el.querySelectorAll('.diff-file');
    expect(files.length).toBe(2);
    expect(el.querySelector('.diff-patch .diff-add')?.textContent).toContain('+new');
    expect(el.querySelector('.diff-patch .diff-del')?.textContent).toContain('-old');
    expect(el.querySelector('.diff-hunk')).not.toBeNull();
    expect(el.querySelector('.diff-patch')?.getAttribute('tabindex')).toBe('0');
    expect(el.querySelector('.diff-patch')?.getAttribute('role')).toBe('region');
    expect(el.querySelector('.diff-patch')?.getAttribute('aria-label')).toContain(diff[0]?.filename);
    expect(el.querySelector('.diff-nopatch')).not.toBeNull();
  });

  it('renders an empty-note when the PR has no file changes', () => {
    const el = mount(renderPrView({ repo: 'org/alpha', number: 42, pr, diff: [], loading: false }, opts));
    expect(el.querySelector('.pr-diff-panel')?.textContent).toContain('No file changes');
  });

  it('renderPrPanel shows an "Open in PR tab" control only when requested', () => {
    expect(mount(renderPrPanel(pr, false, true)).querySelector('.pr-open-in-tab')).not.toBeNull();
    expect(mount(renderPrPanel(pr, false, false)).querySelector('.pr-open-in-tab')).toBeNull();
  });

  it('marks the PR panel decision chip when changes are requested', () => {
    const el = mount(renderPrPanel({ ...pr, reviewDecision: 'CHANGES_REQUESTED', reviews: { requested: 0, approved: 2, changesRequested: 1, commented: 0 } }, false));
    const chip = el.querySelector('.pr-decision-chip');
    expect(chip).not.toBeNull();
    expect(chip!.classList.contains('chip-blocked')).toBe(true);
    expect(chip!.textContent).toContain('Changes requested');
  });

  it.each([0, 1, 2, 3])('shows %s approvals toward the required two', (approved) => {
    const el = mount(renderPrPanel({ ...pr, reviews: { requested: 0, approved, changesRequested: 0, commented: 0 } }, false));
    const progress = el.querySelector('.pr-approval-progress');
    expect(progress?.textContent).toBe(`${approved}/2 approvals${approved < 2 ? ` · ${2 - approved} needed` : ''}`);
    expect(progress?.classList.contains('chip-done')).toBe(approved >= 2);
    expect(el.querySelector('.pr-decision-chip')).toBeNull();
  });

  it('keeps change requests blocking even with two approvals', () => {
    const el = mount(renderPrPanel({ ...pr, reviews: { requested: 0, approved: 2, changesRequested: 1, commented: 0 }, viewerReview: 'APPROVED' }, false));
    expect(el.querySelector('.pr-approval-progress')?.classList.contains('chip-done')).toBe(false);
    expect(el.querySelector('.pr-decision-chip')?.textContent).toBe('Changes requested (1)');
    expect(el.querySelector('.pr-viewer-review')?.textContent).toBe(`Your ${term('review').toLowerCase()}: Approved`);
  });

  it.each([undefined, false])('distinguishes unavailable approval data from zero approvals (%s)', (reviewsAvailable) => {
    const el = mount(renderPrPanel({ ...pr, reviewsAvailable, reviews: reviewsAvailable === false ? { requested: 0, approved: 2, changesRequested: 0, commented: 0 } : undefined }, false));
    expect(el.querySelector('.pr-approval-progress')?.textContent).toBe('Approvals unavailable · 2 required');
    expect(el.querySelector('.pr-approval-progress')?.classList.contains('chip-done')).toBe(false);
  });
});

it('groups every Slack setting in one panel with integration and watcher switches', () => {
  const keys = EDITABLE_KEYS.filter(key => key.startsWith('SLACK_'));
  const config = Object.fromEntries(keys.map(key => [key, key.endsWith('ENABLED') ? 'false' : 'configured']));
  const root = document.createElement('div');
  root.innerHTML = renderConfigView({ config, overridden: [] }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
  const panel = root.querySelector('.slack-review-config');
  expect(panel).not.toBeNull();
  for (const key of keys) {
    expect(root.querySelectorAll(`.config-row[data-key="${key}"]`)).toHaveLength(1);
    expect(panel?.querySelector(`.config-row[data-key="${key}"]`)).not.toBeNull();
  }
  expect(panel?.querySelector<HTMLSelectElement>('#config-SLACK_ENABLED')?.value).toBe('false');
  expect(panel?.querySelector<HTMLSelectElement>('#config-SLACK_WATCH_ENABLED')?.value).toBe('false');
});


describe('accessible configuration states', () => {
  const opts = { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID };

  it('connects every setting to its label and error, and makes Save names unambiguous', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { AGENT_ADAPTER: 'codex', 'unknown key': 'value' }, overridden: [] }, opts);
    for (const row of el.querySelectorAll('.config-row')) {
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
      expect(input?.labels?.length).toBe(1);
      const ids = input?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toContain(row.querySelector('.config-error')?.id);
      for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
      expect(row.querySelector('.config-save')?.getAttribute('aria-label')).toMatch(/^(Save|Update) .+/);
    }
    const ids = Array.from(el.querySelectorAll('[id]')).map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    const adapter = el.querySelector<HTMLInputElement>('#config-AGENT_ADAPTER');
    const helpIds = adapter?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    expect(helpIds.map(id => document.getElementById(id)?.textContent).join(' ')).toContain(CONFIG_HELP.AGENT_ADAPTER);
  });

  it('announces first-load progress without exposing default server settings as loaded values', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { ...opts, loading: true, unavailable: true });
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Loading configuration');
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el.querySelector('.config-input, .config-save')).toBeNull();
    expect(el.querySelector<HTMLSelectElement>('.theme-select')?.value).toBe(DEFAULT_THEME_ID);
    expect(el.querySelector('[data-pirate-mode]')).not.toBeNull();
  });

  it('offers retry for unavailable settings and safely renders the failure', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { ...opts, error: '<img src=x> Invalid configuration response.', unavailable: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Invalid configuration response');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-config-retry]')?.disabled).toBe(false);
    expect(el.querySelector('.config-input')).toBeNull();
  });

  it('keeps previously loaded settings available after a failed refresh and disables duplicate retry', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { AGENT_ADAPTER: 'codex' }, overridden: [] }, { ...opts, error: 'Network unavailable.', loading: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Showing the last loaded settings');
    expect(el.querySelector<HTMLInputElement>('#config-AGENT_ADAPTER')?.value).toBe('codex');
    expect(el.querySelector<HTMLButtonElement>('[data-config-retry]')?.disabled).toBe(true);
  });
});

it('describes how keyboard users can release Terminal capture', () => {
  const el = root();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', isCapturing: true }));
  for (const control of el.querySelectorAll('.cmux-capture-toggle, .cmux-screen')) {
    expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Shift+Escape');
  }
});


it('provides a retry action for Terminal failure without hiding cached terminal tabs', () => {
  const el = root();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', screen: 'last output', error: 'Terminal tabs could not be refreshed.' }));
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('Terminal tabs could not be refreshed.');
  expect(el.querySelector('[data-cmux-refresh]')?.textContent).toBe('Try again');
  expect(el.querySelector('.cmux-tab')).not.toBeNull();
  expect(el.querySelector('.cmux-screen')?.textContent).toBe('last output');
});

it('distinguishes Terminal disconnect from a failed connection check', () => {
  const el = root();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ connected: false }));
  expect(el.querySelector('[role="status"]')?.textContent).toContain('Terminal not connected');
  expect(el.querySelector('[data-cmux-refresh]')).not.toBeNull();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ connected: false, error: 'Could not check terminal connection.' }));
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('Could not check terminal connection');
  expect(el.textContent).not.toContain('Terminal not connected');
});


it('gives Helm and the PR inbox a page heading without changing their visible layout', () => {
  const el = root();
  el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: 'helmsman/helm-page', repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID, readout: null }, '<h1 class="sr-only">Helm</h1>');
  expect(el.querySelector('main h1.sr-only')?.textContent).toBe('Helm');
  el.innerHTML = renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
  expect(el.querySelector('main h1.sr-only')?.textContent).toBe(term('prs'));
});

describe('plugin page shell', () => {
  it('keeps the scoped header, active Helm tab and Recovery link available without a page implementation', () => {
    const el = root();
    el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: 'helmsman/helm-page', repos: ['org/zeta', 'org/alpha'], selectedRepo: 'org/alpha', themeId: DEFAULT_THEME_ID, readout: null }, '<p role="status">Page unavailable</p>');
    const select = el.querySelector<HTMLSelectElement>('.repo-select');
    expect(select).toBe(el.querySelector('.helm-head .nameplate-scope .repo-select'));
    expect(Array.from(select?.options ?? []).map(option => option.value)).toEqual(['', 'org/alpha', 'org/zeta']);
    expect(select?.value).toBe('org/alpha');
    expect(el.querySelector('[data-recovery-link]')?.getAttribute('href')).toBe('/recovery?repo=org%2Falpha');
    const tabs = el.querySelector('.page-tabs');
    const selected = tabs?.querySelector('[aria-selected="true"]');
    const panel = el.querySelector('#page-content');
    expect(tabs?.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    expect(selected?.getAttribute('href')).toBe('/helm?repo=org%2Falpha');
    expect(selected?.id).toBe('page-tab-dashboard');
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected?.id);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(el.querySelector('.helm-head')?.nextElementSibling).toBe(tabs);
    expect(tabs?.nextElementSibling).toBe(panel);
    for (const tab of tabs?.querySelectorAll('[role="tab"]') ?? []) expect(tab.getAttribute('aria-controls')).toBe(panel?.id);
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import type { CompositionLayoutV1, CompositionServiceV1, PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
import bugs from './bugs/page';
import campaigns from './campaigns/page';
import clarifications from './clarifications/page';
import communication from './communication/page';
import compatPr from './compat-pr/page';
import executionSettings from './execution-settings/page';
import githubSettings from './github-settings/page';
import jiraSettings from './jira-settings/page';
import localGit from './local-git/page';
import runHistory from './run-history/page';
import runViewer from './run-viewer/page';
import runs from './runs/page';
import sourceSettings from './source-settings/page';
import terminal from './terminal/page';
import todos from './todos-ui/page';
import triage from './triage/page';

const pages: { name: string; module: PluginPageModule; compositionId: string }[] = [
  { name: 'Bugs', module: bugs, compositionId: 'helmsman/bugs-page' },
  { name: 'Campaigns', module: campaigns, compositionId: 'helmsman/campaigns-page' },
  { name: 'Agent questions', module: clarifications, compositionId: 'helmsman/clarifications-page' },
  { name: 'Communication', module: communication, compositionId: 'helmsman/communication-page' },
  { name: 'Pull requests', module: compatPr, compositionId: 'helmsman/pr-compatibility-page' },
  { name: 'Execution settings', module: executionSettings, compositionId: 'helmsman/execution-settings-page' },
  { name: 'GitHub settings', module: githubSettings, compositionId: 'helmsman/github-settings-page' },
  { name: 'Jira settings', module: jiraSettings, compositionId: 'helmsman/jira-settings-page' },
  { name: 'Local Git', module: localGit, compositionId: 'helmsman/local-git-page' },
  { name: 'Run history', module: runHistory, compositionId: 'helmsman/run-history-page' },
  { name: 'Run viewer', module: runViewer, compositionId: 'helmsman/run-viewer-page' },
  { name: 'Runs', module: runs, compositionId: 'helmsman/runs-page' },
  { name: 'Source settings', module: sourceSettings, compositionId: 'helmsman/source-settings-page' },
  { name: 'Terminal', module: terminal, compositionId: 'helmsman/terminal-page' },
  { name: 'Todos', module: todos, compositionId: 'helmsman/todos-page' },
  { name: 'Triage', module: triage, compositionId: 'helmsman/triage-page' },
];

const state: PluginPageState = { repo: 'owner/project', themeId: 'dark', pirateMode: false, visible: true, pane: null };
const contributionId = 'example.panel/panel';
const title = 'Example panel';
const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(lifetime => lifetime.abort()); document.body.replaceChildren(); });

async function fixture(testPage: (typeof pages)[number], initial: 'single' | 'stacked' | 'collapsed' = 'single') {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  const second = initial === 'stacked';
  let layout: CompositionLayoutV1 = { version: 1, compositionId: testPage.compositionId, revision: 1,
    instances: [
      { instanceId: 'first', contributionId, hidden: false, scope: { kind: 'inherit' }, state: {} },
      ...(second ? [{ instanceId: 'second', contributionId, hidden: false, scope: { kind: 'inherit' } as const, state: {} }] : []),
    ],
    columns: [[{ instances: second ? ['first', 'second'] : ['first'], activeInstanceId: second ? 'second' : 'first', collapsed: initial === 'collapsed' }]],
  };
  const listeners = new Set<() => void>();
  const handles = new Map<string, { setActive: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>();
  const mount = vi.fn<CompositionServiceV1['mount']>(async (id, node) => {
    node.textContent = `Mounted ${id}`;
    const handle = { instanceId: id, setActive: vi.fn(), dispose: vi.fn(), refresh: vi.fn() };
    handles.set(id, handle);
    return handle;
  });
  const readLayout = vi.fn<CompositionServiceV1['readLayout']>(async () => layout);
  const updateLayout = vi.fn<CompositionServiceV1['updateLayout']>(async (next, expected) => {
    if (expected !== layout.revision) throw new Error('Conflict');
    layout = { ...next, revision: expected + 1 };
    listeners.forEach(listener => listener());
    return layout;
  });
  const composition: CompositionServiceV1 = { version: 1, compositionId: testPage.compositionId, readLayout, updateLayout, mount,
    discover: () => [{ id: 'panel', title, pluginId: 'example.panel', contributionId, contract: { id: 'example/panel', version: 1 }, requires: [] }],
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const instance = await testPage.module.mount(container, { state, signal: lifetime.signal, composition, onDispose: vi.fn(), navigate: vi.fn() });
  await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(second ? 2 : 1));
  return { container, instance, composition, handles, readLayout, updateLayout, get layout() { return layout; } };
}

const control = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => button.getAttribute('aria-label') === label || button.textContent === label)!;
const editor = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-label="Page customization"]')!;
const row = (container: HTMLElement, id: string) => [...container.querySelectorAll<HTMLElement>('.composition-panel-row')]
  .find(value => value.dataset.instanceId === id)!;
const mountedNode = (composition: CompositionServiceV1, id: string) => vi.mocked(composition.mount).mock.calls
  .find(([instanceId]) => instanceId === id)?.[1];

it.each(pages)('$name gates composition edits behind Edit page', async testPage => {
  const f = await fixture(testPage);
  const edit = control(f.container, 'Edit page'); const refresh = control(f.container, 'Refresh page');
  expect(edit.title).toBe('Edit page'); expect(edit.getAttribute('aria-pressed')).toBe('false');
  expect(refresh.title).toBe('Refresh page'); expect(refresh.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(editor(f.container).hidden).toBe(true);
  expect(control(f.container, 'Add panel').disabled).toBe(true);
  expect(control(f.container, `Hide ${title}`).disabled).toBe(true);
  expect(control(f.container, `Remove ${title}`).disabled).toBe(true);
  control(f.container, 'Add panel').click(); control(f.container, `Remove ${title}`).click();
  expect(f.updateLayout).not.toHaveBeenCalled();
  edit.click();
  expect(editor(f.container).hidden).toBe(false);
  expect(control(f.container, 'Done').getAttribute('aria-pressed')).toBe('true');
  expect(control(f.container, 'Add panel').disabled).toBe(false);
  expect(control(f.container, `Remove ${title}`).disabled).toBe(false);
  control(f.container, 'Done').click();
  expect(editor(f.container).hidden).toBe(true); expect(control(f.container, 'Add panel').disabled).toBe(true);
});

it.each(pages)('$name removes only the selected duplicate and disposes its mount once', async testPage => {
  const f = await fixture(testPage);
  control(f.container, 'Edit page').click(); control(f.container, 'Add panel').click();
  await vi.waitFor(() => expect(f.layout.instances).toHaveLength(2));
  const added = f.layout.instances.find(instance => instance.instanceId !== 'first')!;
  await vi.waitFor(() => expect(f.handles.has(added.instanceId)).toBe(true));
  expect(row(f.container, added.instanceId).querySelector<HTMLElement>('strong')?.textContent).toBe(`${title} (2)`);
  row(f.container, added.instanceId).querySelector<HTMLButtonElement>(`[aria-label="Remove ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.instances.map(instance => instance.instanceId)).toEqual(['first']));
  await vi.waitFor(() => expect(f.handles.get(added.instanceId)?.dispose).toHaveBeenCalledOnce());
  expect(f.handles.get('first')?.dispose).not.toHaveBeenCalled();
  expect(mountedNode(f.composition, 'first')?.isConnected).toBe(true);
});

it.each(pages)('$name selects a visible sibling when the active stacked panel is removed', async testPage => {
  const f = await fixture(testPage, 'stacked');
  expect([...f.container.querySelectorAll('.composition-panel-tabs button')].map(button => button.textContent)).toEqual([title, title]);
  expect(f.container.querySelector<HTMLButtonElement>('[data-page-action="second:tab"]')?.getAttribute('aria-pressed')).toBe('true');
  control(f.container, 'Edit page').click();
  row(f.container, 'second').querySelector<HTMLButtonElement>(`[aria-label="Remove ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.columns[0]?.[0]).toMatchObject({ instances: ['first'], activeInstanceId: 'first' }));
  await vi.waitFor(() => expect(f.handles.get('second')?.dispose).toHaveBeenCalledOnce());
  expect(mountedNode(f.composition, 'first')?.hidden).toBe(false);
  expect(f.handles.get('first')?.setActive).toHaveBeenLastCalledWith(true);
});

it.each(pages)('$name keeps deliberate emptiness, edit mode and refresh focus through an error', async testPage => {
  const f = await fixture(testPage);
  control(f.container, 'Edit page').click();
  row(f.container, 'first').querySelector<HTMLButtonElement>(`[aria-label="Remove ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.instances).toHaveLength(0));
  await vi.waitFor(() => expect(f.handles.get('first')?.dispose).toHaveBeenCalledOnce());
  expect(f.container.textContent).toContain('No visible panels. Choose Edit page');
  expect(editor(f.container).hidden).toBe(false);
  f.readLayout.mockRejectedValueOnce(new Error('Private failure'));
  const refresh = control(f.container, 'Refresh page'); refresh.focus(); refresh.click();
  await vi.waitFor(() => expect(f.container.querySelector('[role="alert"]')?.textContent).toContain('panels are unavailable'));
  expect(f.layout.instances).toHaveLength(0); expect(f.container.textContent).not.toContain('Private failure');
  expect(editor(f.container).hidden).toBe(false); expect(control(f.container, 'Done').getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Refresh page');
});

it.each(pages)('$name gives a collapsed stack an explicit expand action', async testPage => {
  const f = await fixture(testPage, 'collapsed');
  const expand = control(f.container, `Expand ${title}`);
  expect(expand.closest('.composition-panel-tabs')).not.toBeNull();
  expect(expand.getAttribute('aria-pressed')).toBe('false');
  expand.click();
  await vi.waitFor(() => expect(f.layout.columns[0]?.[0]?.collapsed).toBe(false));
  expect(mountedNode(f.composition, 'first')?.hidden).toBe(false);
});

it.each(pages)('$name restores the shown panel after hiding every member of a stack', async testPage => {
  const f = await fixture(testPage, 'stacked');
  control(f.container, 'Edit page').click();
  row(f.container, 'second').querySelector<HTMLButtonElement>(`[aria-label="Hide ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.instances.find(instance => instance.instanceId === 'second')?.hidden).toBe(true));
  expect(f.layout.columns[0]?.[0]?.activeInstanceId).toBe('first');
  row(f.container, 'first').querySelector<HTMLButtonElement>(`[aria-label="Hide ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.instances.every(instance => instance.hidden)).toBe(true));
  expect(f.container.textContent).toContain('No visible panels. Choose Edit page');
  row(f.container, 'second').querySelector<HTMLButtonElement>(`[aria-label="Show ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.columns[0]?.[0]).toMatchObject({ activeInstanceId: 'second', collapsed: false }));
  expect(mountedNode(f.composition, 'second')?.hidden).toBe(false);
  expect(f.handles.get('second')?.setActive).toHaveBeenLastCalledWith(true);
});

it.each(pages)('$name opens a collapsed stack when a hidden panel is shown', async testPage => {
  const f = await fixture(testPage, 'collapsed');
  control(f.container, 'Edit page').click();
  row(f.container, 'first').querySelector<HTMLButtonElement>(`[aria-label="Hide ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(true));
  row(f.container, 'first').querySelector<HTMLButtonElement>(`[aria-label="Show ${title}"]`)!.click();
  await vi.waitFor(() => expect(f.layout.columns[0]?.[0]).toMatchObject({ activeInstanceId: 'first', collapsed: false }));
  expect(f.layout.instances[0]?.hidden).toBe(false);
  expect(mountedNode(f.composition, 'first')?.hidden).toBe(false);
});

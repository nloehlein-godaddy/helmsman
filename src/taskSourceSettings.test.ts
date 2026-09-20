import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSourceSettings } from './taskSourceSettings';
import { getTaskSources, type TaskSourceView } from './data/taskSources';

const source = (id: string, enabled = true): TaskSourceView => ({ id, sourceId: 'collection', label: id, revision: 3, desiredEnabled: enabled, available: true, identityLevel: 'verified', commands: ['create'], providerId: `example.${id}/tasks`, allowedRepos: ['org/one', 'org/two'], settings: {} });
const originals = [source('todos'), source('jira', false)];
function mount() {
  const root = document.createElement('div'); document.body.append(root);
  const controller = new TaskSourceSettings(() => { root.innerHTML = controller.render(); controller.bind(root.querySelector('[data-task-source-settings]')); });
  return { root, controller };
}
function api() {
  let sources = originals;
  let failing = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (failing) return Response.json({ error: 'Offline' }, { status: 503 });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json(String(input).includes('/schedule')
        ? { repo: new URL(String(input), 'http://localhost').searchParams.get('repo'), instanceIds: body.instanceIds, revision: body.revision + 1 }
        : { instance: { id: String(input).split('/').at(-2), revision: body.instanceRevision + 1, desiredEnabled: body.desiredEnabled } });
    }
    const path = String(input);
    return Response.json(path.includes('/schedule') ? { repo: new URL(path, 'http://localhost').searchParams.get('repo'), instanceIds: ['todos'], revision: 4 } : { instances: sources });
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, fail: () => { failing = true; }, sources: (next: TaskSourceView[]) => { sources = next; } };
}
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('task source settings', () => {
  it('shows independent source configuration and saves with its original revision', async () => {
    const { fetcher } = api(); const { controller, root } = mount(); await controller.load('org/one', ['org/one', 'org/two']);
    expect(root.querySelectorAll('[data-source-id]')).toHaveLength(2);
    const row = root.querySelector<HTMLElement>('[data-source-id="jira"]')!;
    const input = row.querySelector<HTMLInputElement>('[data-source-field="desiredEnabled"]')!;
    input.checked = true; input.dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector<HTMLButtonElement>('[data-source-save]')!.click();
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(call[0]).toBe('/api/task-sources/jira/configuration');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ instanceRevision: 3, label: 'jira', desiredEnabled: true, allowedRepos: ['org/one', 'org/two'], settings: {} });
  });

  it('keeps panel scope separate from header scope and explicitly saves the selected automatic sources', async () => {
    const { fetcher } = api(); const { controller, root } = mount(); await controller.load('org/one', ['org/one', 'org/two']);
    const select = root.querySelector<HTMLSelectElement>('[data-source-scope]')!;
    select.value = 'org/two'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-source-schedule-save]')?.closest('fieldset')?.disabled).toBe(false));
    expect(root.textContent).toContain('Choose sources for org/two');
    expect(root.querySelector('option[value="__header__"]')?.textContent).toBe('Header: org/one');
    const checkbox = root.querySelector<HTMLInputElement>('[data-source-schedule="todos"]')!;
    checkbox.checked = false; checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-source-schedule-save]')!.click();
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([path, init]) => String(path).includes('schedule?repo=org%2Ftwo') && init?.method === 'POST')).toBe(true));
    const call = fetcher.mock.calls.find(([path, init]) => String(path).includes('schedule') && init?.method === 'POST')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ revision: 4, instanceIds: [] });
  });

  it('preserves drafts when the source is unavailable or a reload fails, and blocks stale writes', async () => {
    const mock = api(); const { controller, root } = mount(); await controller.load('org/one', ['org/one']);
    const input = root.querySelector<HTMLInputElement>('[data-source-id="todos"] [data-source-field="label"]')!;
    input.value = 'My draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
    mock.sources([source('jira')]); await controller.load('org/one', ['org/one']);
    mock.sources([{ ...source('todos'), available: false }]); await controller.load('org/one', ['org/one']);
    expect(root.querySelector<HTMLInputElement>('[data-source-field="label"]')?.value).toBe('My draft');
    expect(root.textContent).toContain('unavailable');
    mock.fail(); await controller.load('org/one', ['org/one']);
    expect(root.querySelector<HTMLInputElement>('[data-source-field="label"]')?.value).toBe('My draft');
    expect(root.querySelector<HTMLFieldSetElement>('[data-source-id]')?.disabled).toBe(true);
    expect(root.textContent).toContain('Unsaved changes are kept');
  });

  it('keeps a source draft when a successful HTTP response does not confirm the configuration', async () => {
    const mock = api(); const { controller, root } = mount(); await controller.load('org/one', ['org/one']);
    const input = root.querySelector<HTMLInputElement>('[data-source-id="todos"] [data-source-field="label"]')!;
    input.value = 'Retain this edit'; input.dispatchEvent(new Event('input', { bubbles: true }));
    mock.fetcher.mockResolvedValueOnce(Response.json({ instance: null }));
    root.querySelector<HTMLButtonElement>('[data-source-id="todos"] [data-source-save]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain('Unable to confirm the source configuration'));
    expect(root.querySelector<HTMLInputElement>('[data-source-id="todos"] [data-source-field="label"]')?.value).toBe('Retain this edit');
  });

  it.each(['adoption', 'refresh'] as const)('requires explicit %s validation before committing the retained receipt', async (mode) => {
    const posts: { path: string; body: unknown }[] = [];
    const providerId = mode === 'refresh' ? 'helmsman.jira/issues' : 'external.collection/tasks';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return Response.json(path.endsWith('/validate') ? { validationId: 'validation-1', sourceId: 'collection', instanceId: 'replacement', evidenceHash: 'evidence' } : { sourceId: 'collection', currentInstanceId: 'replacement', revision: 9 });
      }
      if (path.includes(`/${mode}?`)) return Response.json({ sourceId: 'collection', sourceRevision: 8, currentInstanceId: 'todos', candidates: [{ providerId, artifactHash: 'a'.repeat(64) }] });
      if (path.includes('/schedule')) return Response.json({ repo: 'org/one', revision: 4, instanceIds: ['todos'] });
      return Response.json({ instances: [{ ...source('todos'), ...(mode === 'refresh' ? { identityLevel: 'operator-seeded', providerId: 'helmsman.jira/issues' } : {}) }] });
    }));
    const { controller, root } = mount(); await controller.load('org/one', ['org/one']);
    root.querySelector<HTMLButtonElement>('[data-source-adoption="options"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-source-candidate]')).not.toBeNull());
    expect(root.querySelector('[data-source-adoption="commit"]')).toBeNull();
    const select = root.querySelector<HTMLSelectElement>('[data-source-candidate]')!;
    select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true }));
    for (const [key, value] of [['actor', 'operator'], ['reason', 'Compatible implementation']]) {
      const field = root.querySelector<HTMLInputElement>(`[data-source-adoption-field="${key}"]`)!;
      field.value = value!; field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>('[data-source-adoption="validate"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-source-adoption="commit"]')).not.toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ sourceId: 'collection', sourceRevision: 8, providerId, repo: 'org/one', actor: 'operator', reason: 'Compatible implementation' });
    root.querySelector<HTMLButtonElement>('[data-source-adoption="commit"]')!.click();
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ path: `/api/task-sources/${mode}/commit`, body: { validationId: 'validation-1' } });
  });

  it('rejects malformed source payloads before rendering them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ instances: [null] })));
    await expect(getTaskSources(null)).rejects.toThrow('invalid response');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPluginManager } from './plugin-manager';

const hash = 'a'.repeat(64);
const external = { id: 'example.costs', name: 'Costs', version: '1.0.0', kind: 'external', hash, desiredEnabled: false, health: 'healthy', state: 'disabled', revision: 2, obligationsOnly: false };
const builtin = { id: 'helmsman.source-settings', name: 'Source settings', version: '0.4.0', kind: 'builtin', hash: 'b'.repeat(64), desiredEnabled: true, health: 'healthy', state: 'active', revision: 1, obligationsOnly: false };
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
const fixture = () => { const container = document.createElement('div'); document.body.append(container); return container; };

describe('plugin manager', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => response({ version: 1, plugins: [external, builtin], restartRequired: false }))); });
  afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('lists bundled and external plugins truthfully, searches, and preserves header scope', async () => {
    const container = fixture(); const manager = mountPluginManager(container, { repo: 'org/one' });
    await vi.waitFor(() => expect(container.textContent).toContain('Costs'));
    expect(container.textContent).toContain('Bundled · updates with Helmsman');
    expect(container.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe('/source-settings?repo=org%2Fone');
    button(container, 'Details')?.click();
    expect(container.textContent).toContain('Update from .hmp');
    const search = container.querySelector<HTMLInputElement>('input[type=search]')!; search.value = 'source'; search.dispatchEvent(new Event('input'));
    expect(container.textContent).toContain('Source settings'); expect(container.textContent).not.toContain('Costs');
    manager.updateScope('org/two');
    expect(container.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe('/source-settings?repo=org%2Ftwo');
    expect(container.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('source'); manager.dispose();
  });

  it('requires trust before enable and sends expected state; preserves recovery on failure', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ version: 1, plugins: [external] });
      const body = JSON.parse(String(options.body)) as Record<string, unknown>; calls.push(body);
      return response({ error: 'Plugin selection changed.' }, 409);
    }));
    const container = fixture(); mountPluginManager(container, { repo: null });
    await vi.waitFor(() => expect(container.textContent).toContain('Costs'));
    button(container, 'Details')?.click();
    expect(button(container, 'Enable')?.disabled).toBe(true);
    const trust = container.querySelector<HTMLInputElement>('.plugin-manager-inline-trust input')!; trust.click();
    button(container, 'Enable')?.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ action: 'enable', id: external.id, expected: { hash, revision: 2, desiredEnabled: false }, trustConfirmed: true });
    await vi.waitFor(() => expect(container.querySelector('[role=alert]')?.textContent).toContain('Refresh the list before retrying'));
    expect(button(container, 'Refresh plugins')).toBeDefined();
  });

  it('inspects a .hmp file, blocks mismatched updates, and requires explicit archive trust', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ version: 1, plugins: [external] });
      const body = JSON.parse(String(options.body)) as Record<string, unknown>; calls.push(body);
      if (body.action === 'inspect') return response({ version: 1, preview: { id: 'wrong.plugin', name: '<script>alert(1)</script>', version: '2.0.0', kind: 'external', hash, expected: null } });
      return response({ version: 1, plugins: [external], restartRequired: true });
    }));
    const container = fixture(); mountPluginManager(container, { repo: null });
    await vi.waitFor(() => expect(container.textContent).toContain('Costs'));
    button(container, 'Details')?.click(); button(container, 'Update from .hmp')?.click();
    const file = new File(['archive'], 'update.hmp');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('archive').buffer });
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(container.querySelector('[role=alert]')?.textContent).toContain('choose an archive for example.costs'));
    expect(calls.map(call => call.action)).toEqual(['inspect']);
    expect(container.querySelector('script')).toBeNull();
  });

  it('confirms a new inspected archive with its hash and announces restart', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ version: 1, plugins: [] });
      const body = JSON.parse(String(options.body)) as Record<string, unknown>; calls.push(body);
      return body.action === 'inspect'
        ? response({ version: 1, preview: { id: external.id, name: '<script>Costs</script>', version: '1.0.0', kind: 'external', hash, expected: null } })
        : response({ version: 1, plugins: [external], restartRequired: true });
    }));
    const container = fixture(); mountPluginManager(container, { repo: null });
    await vi.waitFor(() => expect(container.textContent).toContain('No plugins are installed'));
    button(container, 'Install plugin')?.click();
    const file = new File(['archive'], 'plugin.hmp');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('archive').buffer });
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(container.textContent).toContain('SHA-256'));
    expect(container.querySelector('script')).toBeNull();
    const confirm = [...container.querySelectorAll('button')].find(node => node.textContent === 'Install plugin' && node !== button(container, 'Install plugin'))!;
    expect(confirm.disabled).toBe(true);
    container.querySelector<HTMLInputElement>('.plugin-manager-trust input')!.click();
    const controls = [...container.querySelectorAll('button')].filter(node => node.textContent === 'Install plugin'); controls[1]?.click();
    await vi.waitFor(() => expect(calls.map(call => call.action)).toEqual(['inspect', 'install']));
    expect(calls[1]).toMatchObject({ action: 'install', confirmedHash: hash, expected: null, trustConfirmed: true });
    await vi.waitFor(() => expect(container.textContent).toContain('Restart Helmsman'));
  });

  it('keeps restart guidance after refresh and disables changes in read-only recovery', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ version: 1, plugins: [external], readOnly: ++reads > 1 });
      return response({ version: 1, plugins: [{ ...external, desiredEnabled: true, state: 'active', revision: 3 }], restartRequired: true, readOnly: false });
    }));
    const container = fixture(); mountPluginManager(container, { repo: null });
    await vi.waitFor(() => expect(container.textContent).toContain('Costs'));
    button(container, 'Details')?.click();
    const trust = container.querySelector<HTMLInputElement>('.plugin-manager-inline-trust input')!; trust.click(); button(container, 'Enable')?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Restart Helmsman'));
    button(container, 'Refresh plugins')?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Safe start: plugin changes are read-only'));
    expect(container.textContent).toContain('Restart Helmsman');
    expect(button(container, 'Install plugin')?.disabled).toBe(true);
    expect(button(container, 'Enable')?.disabled).toBe(true);
    expect(button(container, 'Update from .hmp')?.disabled).toBe(true);
  });

  it('restores server restart guidance on a fresh mount and routes the recovery link through the app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ version: 1, plugins: [external], restartRequired: true, readOnly: false })));
    const container = fixture(); mountPluginManager(container, { repo: 'org/a' });
    await vi.waitFor(() => expect(container.querySelector('[role=status]')?.textContent).toContain('Restart Helmsman'));
    expect(container.querySelector<HTMLAnchorElement>('.plugin-manager-source-link')?.classList.contains('app-link')).toBe(true);
    expect(container.querySelector<HTMLAnchorElement>('.plugin-manager-source-link')?.getAttribute('href')).toBe('/source-settings?repo=org%2Fa');
  });
});

import { describe, expect, it } from 'vitest';
import { renderHelmHead } from './render';
import { DEFAULT_THEME_ID } from './data/themes';

describe('header VPN status', () => {
  it.each(['connected', 'disconnected', 'unknown'] as const)('renders accessible %s evidence without navigation or a scope override', state => {
    document.body.innerHTML = renderHelmHead({ active: 'config', selectedRepo: 'org/a', repos: ['org/a'], themeId: DEFAULT_THEME_ID, readout: null,
      vpnStatus: { version: 1, state, client: state, network: 'not-configured', checkedAt: '2026-10-11T00:00:00Z' } });
    const icon = document.querySelector<HTMLElement>('[data-vpn-status]');
    expect(icon?.closest('.helm-controls')).not.toBeNull();
    expect(icon?.getAttribute('role')).toBe('img');
    expect(icon?.tabIndex).toBe(0);
    expect(icon?.getAttribute('data-state')).toBe(state);
    expect(icon?.getAttribute('aria-label')).toBe(icon?.title);
    expect(icon?.title).toContain('GlobalProtect:');
    expect(icon?.title).toContain('Internal connectivity check not configured.');
    expect(icon?.title).toContain('once a minute');
    expect(document.querySelector('[data-pages-menu]')).toBeNull();
    expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  });

  it('describes conflicting evidence without implying disconnection', () => {
    document.body.innerHTML = renderHelmHead({ active: 'todos', selectedRepo: null, repos: [], themeId: DEFAULT_THEME_ID, readout: null,
      vpnStatus: { version: 1, state: 'unknown', client: 'connected', network: 'unreachable', checkedAt: '2026-10-11T00:00:00Z' } });
    const icon = document.querySelector<HTMLElement>('[data-vpn-status]');
    expect(icon?.title).toContain('Company VPN: Unknown');
    expect(icon?.title).toContain('GlobalProtect: connected');
    expect(icon?.title).toContain('this alone does not prove the VPN is disconnected');
  });
});

import { describe, expect, it } from 'vitest';
import { renderSectionNavigation } from './render';
import { DEFAULT_THEME_ID } from './data/themes';

describe('Config navigation integration status', () => {
  it.each(['available', 'unavailable', 'not-configured', 'unknown', 'checking'] as const)('renders distinct accessible %s symbols without changing link names or scope', status => {
    document.body.innerHTML = renderSectionNavigation({ active: 'config', selectedRepo: 'org/a', repos: ['org/a'], themeId: DEFAULT_THEME_ID, readout: null,
      integrationStatus: { repo: 'org/a', jira: status, github: status } });
    for (const kind of ['jira', 'github']) {
      const icon = document.querySelector(`[data-integration-status="${kind}"]`);
      const link = icon?.closest('a');
      expect(icon?.getAttribute('data-status')).toBe(status);
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(link?.getAttribute('aria-label')).toBe(kind === 'jira' ? 'Jira' : 'GitHub');
      expect(link?.getAttribute('href')).toContain('repo=org%2Fa');
      expect(link?.getAttribute('aria-describedby')).toBe(`${kind}-integration-status-description`);
      expect(document.getElementById(`${kind}-integration-status-description`)?.textContent).toBe(link?.title);
    }
  });

  it('never displays stale healthy results from another galleon', () => {
    document.body.innerHTML = renderSectionNavigation({ active: 'config', selectedRepo: 'org/b', repos: ['org/a', 'org/b'], themeId: DEFAULT_THEME_ID, readout: null,
      integrationStatus: { repo: 'org/a', jira: 'available', github: 'available' } });
    expect([...document.querySelectorAll('[data-integration-status]')].map(icon => icon.getAttribute('data-status'))).toEqual(['unknown', 'unknown']);
  });

  it('distinguishes Jira identity checks from scoped GitHub read access', () => {
    document.body.innerHTML = renderSectionNavigation({ active: 'config', selectedRepo: 'org/a', repos: ['org/a'], themeId: DEFAULT_THEME_ID, readout: null,
      integrationStatus: { repo: 'org/a', jira: 'available', github: 'available' } });
    expect(document.getElementById('jira-integration-status-description')?.textContent).toContain('Task access has not been checked');
    expect(document.getElementById('github-integration-status-description')?.textContent).toContain('pull requests accessible for org/a');
  });
});

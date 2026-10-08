import { afterEach, describe, expect, it } from 'vitest';
import { renderAppShell, renderConfigView, renderHelmHead } from './render';
import { DEFAULT_THEME_ID } from './data/themes';
import { setPirateMode } from './logic/terminology';

afterEach(() => { setPirateMode(true); localStorage.clear(); });

const mount = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};
const opts = { repos: ['org/agent-review'], selectedRepo: 'org/agent-review', themeId: DEFAULT_THEME_ID };

describe('pirate interface wording', () => {
  it.each([true, false])('renders neutral greetings, a profile mount, and switchable navigation with mode=%s', enabled => {
    setPirateMode(enabled);
    const element = mount(renderHelmHead({ ...opts, active: 'dashboard', readout: { running: 1, queued: 0, review: 2 } }));
    expect(element.querySelector('[data-greeting]')?.textContent).toBe(enabled ? 'Ahoy' : 'Hello');
    expect(element.querySelector('.helm-greeting')?.textContent).toBe(`${enabled ? 'Ahoy' : 'Hello'}!`);
    expect(element.querySelector('[data-profile-header]')?.textContent).toBe('');
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('[data-view="dashboard"]')?.textContent).toBe(enabled ? 'Helm' : 'Dashboard');
    expect(element.querySelector('[data-view="prs"]')?.textContent).toBe(enabled ? 'Bounties' : 'PRs');
    expect(element.querySelector('[data-view="runs"]')?.textContent).toBe(enabled ? 'Voyages' : 'Runs');
    expect(element.querySelector('.repo-select')?.getAttribute('aria-label')).toBe(enabled ? 'Scope by galleon' : 'Scope by repository');
    expect(element.querySelector('.helm-readout')?.getAttribute('aria-label')).toBe(enabled ? 'Fleet status' : 'System status');
    expect(element.querySelector('[data-readout-label="review"]')?.textContent).toBe(enabled ? 'inspection' : 'review');
    expect(element.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/agent-review');
  });

  it.each([true, false])('reflects mode=%s in the footer and keeps the Appearance reference and Communication link literal', enabled => {
    setPirateMode(enabled);
    const element = mount(renderConfigView({ config: {}, overridden: [] }, opts));
    expect(element.querySelectorAll('[data-pirate-mode]')).toHaveLength(2);
    expect(element.querySelector('.app-footer [data-pirate-mode]')?.getAttribute('aria-pressed')).toBe(String(enabled));
    expect(element.querySelector('.app-footer [data-pirate-mode]')?.getAttribute('title')).toBe(`Turn Pirate mode ${enabled ? 'off' : 'on'}`);
    expect(element.querySelector('.ui-customization-panel [data-pirate-mode]')?.getAttribute('role')).toBe('switch');
    expect(element.querySelector('.ui-customization-panel [data-pirate-mode]')?.getAttribute('aria-checked')).toBe(String(enabled));
    const icon = element.querySelector('.ui-customization-panel [data-pirate-icon]');
    expect(icon?.getAttribute('data-pirate-icon')).toBe(enabled ? 'treasure-chest' : 'briefcase');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('#pirate-mode-help')?.textContent).toContain('Your content stays unchanged');
    const rows = Array.from(element.querySelectorAll('.terminology-reference tbody tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent));
    expect(rows).toEqual(expect.arrayContaining([
      ['Dashboard', 'Helm'], ['Runs', 'Voyages'], ['Repositories', 'Galleons'],
      ['Agents', 'Crew'], ['Running', 'Underway'], ['System status', 'Fleet status'],
      ['Completed work', 'Out to sea'], ['Activity log', "Ship's log"],
    ]));
    expect(element.querySelector('.section-nav a[href="/communication?repo=org%2Fagent-review"]')?.textContent).toBe('Notifications');
    expect(element.querySelector('#page-content a[href="/communication?repo=org%2Fagent-review"]')).toBeNull();
    expect(element.querySelector('#slack-review-setup')).toBeNull();
    expect(element.textContent).toContain('Task sources');
    expect(element.querySelector('[data-key=JIRA_ENABLED]')).toBeNull();
  });

  it.each(['dashboard', 'prs', 'runs', 'todos', 'triage', 'bugs', 'cmux', 'config'] as const)('provides one accessible footer flag on %s', active => {
    setPirateMode(false);
    const element = mount(renderAppShell({ ...opts, active, readout: null }, 'Content'));
    const button = element.querySelector<HTMLButtonElement>('.app-footer [data-pirate-mode]');
    expect(element.querySelectorAll('[data-pirate-mode]')).toHaveLength(1);
    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Pirate mode');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.title).toBe('Turn Pirate mode on');
    expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button?.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
    const metadata = element.querySelector('.footer-meta');
    const controls = button?.closest('.footer-controls');
    expect(controls?.parentElement).toBe(element.querySelector('.app-footer'));
    expect(controls?.querySelector('[data-feedback-footer]')).not.toBeNull();
    expect(metadata?.querySelector<HTMLDetailsElement>('.footer-about')?.open).toBe(false);
    expect(metadata?.querySelector('.footer-about-content .footer-attr')?.textContent).toBe('nloehlein@godaddy.com');
    expect(metadata?.querySelector('[data-recovery-link]')?.closest('details')).toBeNull();
    expect(metadata?.compareDocumentPosition(button!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

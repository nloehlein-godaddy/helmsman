import { describe, expect, it } from 'vitest';
import { renderConfigView } from './render';

function mount(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('Config communication navigation', () => {
  it.each([null, 'org/a'])('links to authored Communication settings with header scope %s', selectedRepo => {
    const root = mount(renderConfigView({ config: {}, overridden: [] }, { repos: ['org/a'], selectedRepo, themeId: 'quarterdeck' }));
    const link = [...root.querySelectorAll<HTMLAnchorElement>('a.app-link')]
      .find(item => item.textContent === 'Notifications and Slack settings');
    expect(link?.getAttribute('href')).toBe(selectedRepo ? '/communication?repo=org%2Fa' : '/communication');
    expect(root.querySelector('.slack-review-config, #slack-review-setup')).toBeNull();
  });

  it('keeps Slack destinations and credentials out of core configuration fields', () => {
    const payload = '\"><img src=x onerror=alert(1)>';
    const root = mount(renderConfigView({ config: {
      SLACK_REVIEW_CHANNEL: payload, SLACK_REVIEW_MENTION: payload, SLACK_BOT_TOKEN: 'private-token',
    }, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'quarterdeck' }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[data-key^="SLACK_"], [id^="config-SLACK_"]')).toBeNull();
    expect(root.textContent).not.toContain(payload);
    expect(root.innerHTML).not.toContain('private-token');
  });
});

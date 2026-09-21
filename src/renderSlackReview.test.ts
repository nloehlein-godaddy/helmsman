import { describe, expect, it } from 'vitest';
import { renderConfigView } from './render';

function mount(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('Slack review controls', () => {

  it('renders Slack destinations with browser setup and no bot credentials', () => {
    const root = mount(renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'quarterdeck' }));
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_REVIEW_CHANNEL')?.value).toBe('airo-editing');
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_REVIEW_MENTION')?.value).toBe('airo-editing-squad');
    expect(root.querySelector('#config-SLACK_BOT_TOKEN')).toBeNull();
    expect(root.querySelector('#slack-review-setup')?.textContent).toContain('signed-in Slack browser');
    expect(root.querySelector('.slack-review-config')?.textContent).toContain('only when you click');
  });

  it('escapes saved Slack destinations inside configuration fields', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const root = mount(renderConfigView({ config: { SLACK_REVIEW_CHANNEL: payload, SLACK_REVIEW_MENTION: payload }, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'quarterdeck' }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_REVIEW_CHANNEL')?.value).toBe(payload);
    expect(root.querySelector('.slack-review-config input[type=password]')).toBeNull();
  });
});

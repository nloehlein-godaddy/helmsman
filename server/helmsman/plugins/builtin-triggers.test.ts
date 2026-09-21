import { describe, expect, it } from 'vitest';
import { builtinTriggers } from './builtin-triggers';

describe('builtin triggers', () => {
  it('publishes four independently configurable trigger packages', () => {
    expect(builtinTriggers.map(entry => entry.package.manifest.id)).toEqual([
      'helmsman.trigger-campaign',
      'helmsman.trigger-slack-review',
      'helmsman.trigger-github-review',
      'helmsman.trigger-github-webhook',
    ]);
    expect(builtinTriggers.map(entry => entry.package.backend?.triggers)).toEqual([
      { dispatch: { access: ['campaign-candidates'] } },
      { watch: { access: ['review-discovery'] } },
      { watch: { access: ['review-discovery'] } },
      { github: { access: ['authenticated-event'] } },
    ]);
  });

  it('retains shipped enablement, polling, filtering, and route settings', () => {
    const [campaign, slack, github, webhook] = builtinTriggers.map(entry => entry.package.backend?.settings);
    expect(campaign).toMatchObject({ enabled: { default: true }, intervalMs: { default: 5_000 } });
    expect(slack).toMatchObject({ enabled: { default: true }, intervalMs: { default: 300_000 }, overlapSeconds: { default: 300 }, repoFilterJson: { default: '[]' } });
    expect(github).toMatchObject({ enabled: { default: true }, intervalMs: { default: 300_000 } });
    expect(webhook).toMatchObject({ enabled: { default: false }, routesJson: { default: '[]' } });
  });
});

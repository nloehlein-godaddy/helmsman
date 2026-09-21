import type { CampaignTriggerProviderV1 } from '@helmsman/plugin-sdk';

export function campaignTriggerProvider(settings: { readonly enabled: boolean; readonly intervalMs: number }): CampaignTriggerProviderV1 {
  return {
    metadata: { version: 1, label: 'Campaign dispatch', kind: 'campaign', intervalMs: settings.intervalMs },
    select(input) {
      if (!settings.enabled) return null;
      const candidate = input.candidates[0];
      return candidate ? { candidateId: candidate.candidateId } : null;
    },
  };
}

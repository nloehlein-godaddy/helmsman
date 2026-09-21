import { ClarificationJournalConflictError } from './clarification-journal';
import { clarificationAvailable, clarificationUnavailable, createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { createCampaignCommandJournal, type CampaignCommandJournal } from './campaigns-command-journal';
import { CAMPAIGN_LIMITS, parseCampaignCommandInputV1, parseCampaignCommandReceiptV1, parseCampaignDetailSnapshotV1, parseCampaignListSnapshotV1, parseCampaignReceiptQueryV1,
  type CampaignCommandReceiptV1, type CampaignCommandV1, type CampaignServiceV1 } from './campaigns';
import { clarificationId } from './clarification-validation';
import { parseTaskRepo } from './tasks';
import type { ClarificationReadResultV1 } from './clarification-read';

export function createHostCampaignService(lifetime: AbortSignal, options: ClarificationHostOptions & { journal?: CampaignCommandJournal }): CampaignServiceV1 {
  const journal = options.journal ?? createCampaignCommandJournal(options.caller);
  const operation = createClarificationTransport(lifetime, options, CAMPAIGN_LIMITS.responseBytes); type Call = ReturnType<typeof operation>;
  async function record(result: ClarificationReadResultV1<CampaignCommandReceiptV1 | null>, call: Call) {
    if (result.status === 'unavailable' || result.value === null) return result;
    try { const receipt = await journal.record(result.value); call.check(); return clarificationAvailable(receipt); }
    catch { call.check(); return clarificationUnavailable('service-unavailable'); }
  }
  async function send(command: CampaignCommandV1, call: Call) {
    const result = await record(await call.request('/api/campaign-service/commands', data => parseCampaignCommandReceiptV1(data, command), { command, scopeRepo: call.scope.repo }), call);
    return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
  }
  return Object.freeze<CampaignServiceV1>({
    version: 1,
    async list(input, signal) {
      if (input?.version !== 1) throw new TypeError('Invalid campaigns version');
      const repo = input.repo === null ? null : parseTaskRepo(input.repo); const call = operation(signal);
      if (call.scope.repo !== null && call.scope.repo !== repo) return clarificationUnavailable('forbidden');
      const query = new URLSearchParams({ version: '1' }); if (repo !== null) query.set('repo', repo); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/campaign-service/list?${query}`, data => { const value = parseCampaignListSnapshotV1(data); if (value.repo !== repo) throw new TypeError('Campaign scope changed'); return value; });
    },
    async detail(input, signal) {
      if (input?.version !== 1) throw new TypeError('Invalid campaigns version');
      const repo = parseTaskRepo(input.repo); const campaignId = clarificationId(input.campaignId); const call = operation(signal);
      if (!call.allowed(repo)) return clarificationUnavailable('forbidden');
      const query = new URLSearchParams({ version: '1', repo, campaignId }); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/campaign-service/detail?${query}`, data => { const value = parseCampaignDetailSnapshotV1(data); if (value.campaign.repo !== repo || value.campaign.id !== campaignId) throw new TypeError('Campaign target changed'); return value; });
    },
    async submit(value, signal) {
      const input = parseCampaignCommandInputV1(value); const call = operation(signal); if (!call.allowed(input.repo)) return clarificationUnavailable('forbidden');
      try { const command = await journal.reserve(input, call.signal); call.check(); call.signal.throwIfAborted(); return send(command, call); }
      catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalConflictError ? 'conflict' : 'service-unavailable'); }
    },
    async retry(value, signal) {
      const input = parseCampaignReceiptQueryV1(value); const call = operation(signal); if (!call.allowed(input.repo)) return clarificationUnavailable('forbidden');
      const command = await journal.retained(input, call.signal); call.check(); call.signal.throwIfAborted();
      return command ? send(command, call) : clarificationUnavailable('not-found');
    },
    async receipt(value, signal) {
      const input = parseCampaignReceiptQueryV1(value); const call = operation(signal); if (!call.allowed(input.repo)) return clarificationUnavailable('forbidden');
      const command = await journal.retained(input, call.signal); call.check(); if (!command) return clarificationUnavailable('not-found');
      const query = new URLSearchParams({ repo: input.repo }); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return record(await call.request(`/api/campaign-service/receipts/${input.requestId}?${query}`, data => data === null ? null : parseCampaignCommandReceiptV1(data, command)), call);
    },
    async pending(signal) { const call = operation(signal); const values = await journal.pending(call.signal); call.check(); return Object.freeze(values.filter(item => call.allowed(item.command.repo))); },
    async acknowledge(value, signal) {
      const query = parseCampaignReceiptQueryV1(value); const call = operation(signal); if (!call.allowed(query.repo)) throw new TypeError('Campaign request is outside the current scope');
      await journal.acknowledge(query, call.signal); call.check();
    },
  });
}

import type { PluginJson, SourceEffectContextV1, SourceEffectHandlerV1, SourceEffectResultV1 } from '@helmsman/plugin-sdk';
import { jiraRecord, jiraText } from './normalize.js';
import { findJiraTransition, jiraIssueId, readJiraState } from './http.js';
import type { JiraState } from './http.js';

type Input = { target: PluginJson; payload: PluginJson };
function parse(input: Input, context: SourceEffectContextV1, kind: 'assign' | 'transition') {
  const target = jiraRecord(input?.target);
  const payload = jiraRecord(input?.payload);
  if (target?.sourceId !== context.instance.sourceId || !jiraIssueId(target?.issueId) || !payload
    || !jiraText(payload.expectedStatusId, 128) || payload.expectedAccountId !== null && !jiraText(payload.expectedAccountId, 320)) throw new Error('Invalid pinned Jira effect');
  if (kind === 'assign' && !jiraText(payload.accountId, 320)) throw new Error('Invalid Jira assignment');
  if (kind === 'transition' && (!jiraText(payload.transitionId, 128) || !jiraText(payload.statusId, 128) || !jiraText(payload.statusName, 240))) throw new Error('Invalid Jira transition');
  return { issueId: target.issueId, payload };
}
function stateEvidence(state: JiraState): PluginJson { return { issueId: state.issueId, statusId: state.statusId, statusName: state.statusName, accountId: state.accountId }; }
function satisfied(kind: 'assign' | 'transition', state: JiraState, payload: Record<string, unknown>): boolean {
  return kind === 'assign' ? state.accountId === payload.accountId && state.statusId === payload.expectedStatusId
    : state.statusId === payload.statusId && state.accountId === payload.expectedAccountId;
}
function acknowledged(kind: string, state: JiraState): SourceEffectResultV1 { return { status: 'acknowledged', receipt: { version: 1, kind, ...state } }; }
function handler(kind: 'assign' | 'transition'): SourceEffectHandlerV1 {
  return {
    delivery: 'reconcile',
    async reconcile(input, context): Promise<SourceEffectResultV1> {
      try {
        const { issueId, payload } = parse(input, context, kind);
        const state = await readJiraState(context.http, context.signal, issueId);
        return satisfied(kind, state, payload) ? acknowledged(kind, state)
          : { status: 'unknown', reason: 'Current Jira state cannot prove whether the previous operation applied.', evidence: stateEvidence(state) };
      } catch { return { status: 'unknown', reason: 'Pinned Jira state is unavailable for reconciliation.', evidence: { code: 'jira-read-failed' } }; }
    },
    async invoke(input, context): Promise<SourceEffectResultV1> {
      let attempted = false;
      try {
        const { issueId, payload } = parse(input, context, kind);
        let state = await readJiraState(context.http, context.signal, issueId);
        if (satisfied(kind, state, payload)) return acknowledged(kind, state);
        const conflict = () => state.statusId !== payload.expectedStatusId || state.accountId !== payload.expectedAccountId;
        if (conflict()) return { status: 'definitely-not-applied', retryable: false, reason: 'Jira changed after the operation was admitted.', evidence: stateEvidence(state) };
        if (kind === 'transition') {
          const transition = await findJiraTransition(context.http, context.signal, issueId, String(payload.statusName));
          if (transition.id !== payload.transitionId || transition.statusId !== payload.statusId) return { status: 'definitely-not-applied', retryable: false, reason: 'The pinned Jira transition changed.', evidence: { transitionId: transition.id, statusId: transition.statusId } };
          state = await readJiraState(context.http, context.signal, issueId);
          if (satisfied(kind, state, payload)) return acknowledged(kind, state);
          if (conflict()) return { status: 'definitely-not-applied', retryable: false, reason: 'Jira changed while the transition was prepared.', evidence: stateEvidence(state) };
        }
        context.signal.throwIfAborted();
        attempted = true;
        const result = await context.http.send({ method: kind === 'assign' ? 'PUT' : 'POST', path: `/rest/api/3/issue/${issueId}/${kind === 'assign' ? 'assignee' : 'transitions'}`,
          body: kind === 'assign' ? { accountId: String(payload.accountId) } : { transition: { id: String(payload.transitionId) } } });
        if (result?.status >= 200 && result.status < 300) return acknowledged(kind, { ...state,
          ...(kind === 'assign' ? { accountId: String(payload.accountId) } : { statusId: String(payload.statusId), statusName: String(payload.statusName) }) });
        if (result?.status >= 400 && result.status < 500 && result.status !== 408) return { status: 'definitely-not-applied', retryable: result.status === 429, reason: `Jira rejected the operation (${result.status}).`, evidence: { httpStatus: result.status } };
        return { status: 'unknown', reason: 'Jira did not reliably acknowledge the operation.', evidence: { httpStatus: result?.status ?? null } };
      } catch {
        return attempted ? { status: 'unknown', reason: 'Jira delivery could not be confirmed.', evidence: { code: 'jira-write-unconfirmed' } }
          : { status: 'definitely-not-applied', retryable: true, reason: 'Jira operation could not be prepared.', evidence: { code: 'jira-preparation-failed' } };
      }
    },
  };
}
const retainClaim: SourceEffectHandlerV1 = {
  delivery: 'reconcile',
  async invoke(input, context): Promise<SourceEffectResultV1> { return this.reconcile(input, context); },
  async reconcile(input, context): Promise<SourceEffectResultV1> {
    const target = jiraRecord(input?.target);
    if (target?.sourceId !== context.instance.sourceId || !jiraIssueId(target?.issueId)) return { status: 'blocked', reason: 'Pinned Jira claim is invalid.', evidence: { code: 'invalid-claim' } };
    try {
      const state = await readJiraState(context.http, context.signal, target.issueId);
      return { status: 'blocked', reason: 'An applied or uncertain Jira claim requires operator settlement.', evidence: stateEvidence(state) };
    } catch { return { status: 'blocked', reason: 'An applied or uncertain Jira claim requires operator settlement; Jira state is unavailable.', evidence: { issueId: target.issueId } }; }
  },
};
export const jiraEffects: Readonly<Record<string, SourceEffectHandlerV1>> = Object.freeze({ assign: handler('assign'), transition: handler('transition'), 'retain-claim': retainClaim });

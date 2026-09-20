import type { JiraConfig } from '../config';
import type { ProviderBinding } from './execution-store';
import type { OperationAdapter, OperationContext } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';

export interface JiraOperationTarget { baseUrl: string; issueId: string; }
export interface JiraOperationState { target: JiraOperationTarget; accountId: string | null; statusId: string; statusName: string; }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function origin(value: unknown): string {
  if (!text(value)) throw new Error('Jira connection is missing');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Jira tenant must be an HTTPS origin');
  return url.origin;
}
function headers(jira: JiraConfig): Record<string, string> {
  if (!text(jira?.email) || !text(jira?.apiToken)) throw new Error('Jira credentials are unavailable');
  return { Authorization: `Basic ${Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}
function issueUrl(baseUrl: string, issueId: string, suffix = ''): string {
  if (!text(issueId) || issueId.length > 256) throw new Error('Jira issue identity is invalid');
  return `${origin(baseUrl)}/rest/api/3/issue/${encodeURIComponent(issueId)}${suffix}`;
}
export async function readJiraOperationTarget(jira: JiraConfig, issueId: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<JiraOperationState> {
  const response = await fetcher(`${issueUrl(jira.baseUrl, issueId)}?fields=assignee,status`, { headers: headers(jira), signal: signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Jira issue lookup failed (${response.status})`);
  const body = object(await response.json());
  const fields = object(body?.fields);
  const status = object(fields?.status);
  const assignee = fields?.assignee;
  const accountId = assignee === null ? null : object(assignee)?.accountId;
  if (!text(body?.id) || !text(status?.id) || !text(status?.name) || accountId !== null && !text(accountId)) throw new Error('Jira returned invalid issue state');
  return { target: { baseUrl: origin(jira.baseUrl), issueId: body.id }, accountId, statusId: status.id, statusName: status.name };
}

export function createJiraOperationAdapter(options: {
  binding: ProviderBinding; kind: 'jira.assign' | 'jira.transition'; jira: JiraConfig; fetcher?: typeof fetch;
  authorize?: OperationAdapter['authorize'];
}): OperationAdapter {
  const fetcher = options.fetcher ?? fetch;
  function input(operation: DurableOperation) {
    const target = object(operation.target);
    const payload = object(operation.payload);
    if (!target || !payload || origin(target.baseUrl) !== origin(options.jira.baseUrl) || !text(target.issueId)) throw new Error('Pinned Jira tenant or issue is unavailable');
    if (options.kind === 'jira.assign' && (!text(payload.accountId) || payload.expectedAccountId !== null && !text(payload.expectedAccountId))) throw new Error('Pinned Jira assignment is invalid');
    if (options.kind === 'jira.transition' && (!text(payload.statusName) || !text(payload.expectedStatusId))) throw new Error('Pinned Jira transition is invalid');
    return { target: { baseUrl: origin(target.baseUrl), issueId: target.issueId }, payload };
  }
  const satisfied = (state: JiraOperationState, payload: Record<string, unknown>) => options.kind === 'jira.assign'
    ? state.accountId === payload.accountId : state.statusName.toLowerCase() === String(payload.statusName).toLowerCase();
  async function read(operation: DurableOperation, context: OperationContext) {
    const { target, payload } = input(operation);
    const state = await readJiraOperationTarget(options.jira, target.issueId, fetcher, context.signal);
    if (state.target.issueId !== target.issueId) throw new Error('Jira issue identity changed');
    return { state, target, payload };
  }
  const receipt = (state: JiraOperationState): OperationResult => ({ status: 'acknowledged', receipt: { ...state.target, accountId: state.accountId, statusId: state.statusId, statusName: state.statusName } });
  return {
    kind: options.kind, binding: options.binding, delivery: 'reconcile', ...(options.authorize ? { authorize: options.authorize } : {}),
    async reconcile(operation, context): Promise<OperationResult> {
      try {
        const { state, payload } = await read(operation, context);
        return satisfied(state, payload) ? receipt(state) : { status: 'unknown', reason: 'Jira state does not prove whether the previous request applied.', evidence: { statusId: state.statusId, accountId: state.accountId } };
      } catch { return { status: 'unknown', reason: 'Pinned Jira state is unavailable for reconciliation.', evidence: { code: 'jira-read-failed' } }; }
    },
    async invoke(operation, context): Promise<OperationResult> {
      let attempted = false;
      try {
        const { state, target, payload } = await read(operation, context);
        if (satisfied(state, payload)) return receipt(state);
        if (options.kind === 'jira.assign' ? state.accountId !== payload.expectedAccountId : state.statusId !== payload.expectedStatusId) {
          return { status: 'definitely-not-applied', retryable: false, reason: 'Jira state changed after this operation was admitted.', evidence: { statusId: state.statusId, accountId: state.accountId } };
        }
        let body: unknown;
        let suffix: string;
        if (options.kind === 'jira.assign') { body = { accountId: payload.accountId }; suffix = '/assignee'; }
        else {
          const response = await fetcher(issueUrl(target.baseUrl, target.issueId, '/transitions'), { headers: headers(options.jira), signal: context.signal });
          if (!response.ok) throw new Error('Jira transitions unavailable');
          const data = object(await response.json());
          if (!Array.isArray(data?.transitions)) throw new Error('Invalid Jira transitions');
          const matches = data.transitions.flatMap(candidate => {
            const transition = object(candidate);
            const to = object(transition?.to);
            return text(transition?.id) && text(to?.name) && to.name.toLowerCase() === String(payload.statusName).toLowerCase() ? [transition.id] : [];
          });
          if (matches.length !== 1) return { status: 'definitely-not-applied', retryable: false, reason: 'Jira transition is unavailable or ambiguous.', evidence: { matches: matches.length } };
          body = { transition: { id: matches[0] } }; suffix = '/transitions';
        }
        const authorization = await options.authorize?.(operation, context);
        if (authorization && !authorization.allowed) return { status: 'definitely-not-applied', retryable: false, reason: authorization.reason, evidence: { code: 'authorization-blocked' } };
        context.signal.throwIfAborted();
        attempted = true;
        const response = await fetcher(issueUrl(target.baseUrl, target.issueId, suffix), {
          method: options.kind === 'jira.assign' ? 'PUT' : 'POST', headers: headers(options.jira), body: JSON.stringify(body), signal: context.signal,
        });
        if (response.ok) return { status: 'acknowledged', receipt: { ...target, kind: options.kind, payload: operation.payload, httpStatus: response.status } };
        return response.status >= 400 && response.status < 500
          ? { status: 'definitely-not-applied', retryable: response.status === 429, reason: `Jira rejected the operation (${response.status}).`, evidence: { httpStatus: response.status } }
          : { status: 'unknown', reason: 'Jira did not reliably acknowledge the operation.', evidence: { httpStatus: response.status } };
      } catch {
        return attempted ? { status: 'unknown', reason: 'Jira delivery could not be confirmed.', evidence: { code: 'jira-write-unconfirmed' } }
          : { status: 'definitely-not-applied', retryable: true, reason: 'Jira operation could not be prepared.', evidence: { code: 'jira-preparation-failed' } };
      }
    },
  };
}

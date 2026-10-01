const FEEDBACK_MARKER_TOKEN = '{{helmsman-feedback-marker}}';
import type { FeedbackHttpRequestV1, FeedbackSubmissionV1, FeedbackTrackerContextV1, FeedbackTrackerProviderV1, FeedbackTrackerResultV1, PluginJson } from '@helmsman/plugin-sdk';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const unknown = (): FeedbackTrackerResultV1 => ({ status: 'unknown', reason: 'Issue creation is not confirmed. Reconcile the saved request before creating another issue.', evidence: { kind: 'unconfirmed' } });
export function createGithubFeedbackTracker(settings: Readonly<Record<string, PluginJson>>): FeedbackTrackerProviderV1 {
  const repo = typeof settings.repository === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(settings.repository) && !['.', '..'].includes(settings.repository.split('/')[1] ?? '') ? settings.repository : null;
  const labels = typeof settings.labels === 'string' ? settings.labels.split(',').map(value => value.trim()).filter(Boolean) : [];
  if (labels.length > 10 || labels.some(label => label.length > 50 || /[\x00-\x1f]/.test(label))) throw new Error('Invalid feedback labels');
  const destination = () => settings.enabled === true && repo ? { id: `github-issues:${repo.toLowerCase()}`, label: `${repo} issues`, url: `https://github.com/${repo}/issues` } : null;
  const get = (path: string, query: Record<string, string> = {}): FeedbackHttpRequestV1 => ({ method: 'GET', path, query, body: null });
  async function actor(context: FeedbackTrackerContextV1): Promise<string> {
    const response = await context.http.request(get('/user')); const user = object(response.body);
    if (response.status !== 200 || typeof user?.login !== 'string' || !/^[a-z\d-]{1,39}$/i.test(user.login)) throw new Error('Authenticated GitHub account is unavailable');
    return user.login.toLowerCase();
  }
  function receipt(value: unknown, input: FeedbackSubmissionV1): FeedbackTrackerResultV1 | null {
    const issue = object(value); const target = object(input.plan.target); const body = object(input.request.body);
    const expectedRepo = target?.repo;
    if (typeof expectedRepo !== 'string' || !issue || issue.pull_request !== undefined || !Number.isSafeInteger(issue.number) || Number(issue.number) < 1
      || issue.title !== body?.title || issue.body !== body?.body || (typeof object(issue.user)?.login !== 'string' || (object(issue.user)?.login as string).toLowerCase() !== target?.actor)
      || issue.html_url !== `https://github.com/${expectedRepo}/issues/${issue.number}`) return null;
    return { status: 'acknowledged', receipt: { id: String(issue.number), url: issue.html_url as string } };
  }
  return {
    async destination() { return destination(); },
    async prepareSubmission(input, context) {
      const selected = destination(); if (!selected || !repo) throw new Error('Feedback tracker is not configured');
      if (input.title.includes(FEEDBACK_MARKER_TOKEN) || input.body.includes(FEEDBACK_MARKER_TOKEN)) throw new Error('Feedback contains a reserved marker');
      const login = await actor(context);
      const metadata = `Helmsman ${input.context.version} · ${input.context.page}${input.context.repo ? ` · ${input.context.repo}` : ''}`;
      return { destination: selected, target: { repo, actor: login }, request: { method: 'POST', path: `/repos/${repo}/issues`, query: {},
        body: { title: input.title, body: `${input.body}\n\n${metadata}\n\n<!-- ${FEEDBACK_MARKER_TOKEN} -->`, labels } } };
    },
    async invokeSubmission(input, context): Promise<FeedbackTrackerResultV1> {
      if (await actor(context) !== object(input.plan.target)?.actor) return { status: 'definitely-not-applied', retryable: false, reason: 'The authenticated GitHub account changed.', evidence: { kind: 'actor-changed' } };
      try {
        const response = await context.http.request(input.request);
        if ([400, 401, 403, 404, 410, 422].includes(response.status)) return { status: 'definitely-not-applied', retryable: false, reason: `GitHub rejected issue creation (${response.status}).`, evidence: { status: response.status } };
        return response.status === 201 ? receipt(response.body, input) ?? unknown() : unknown();
      } catch { return unknown(); }
    },
    async reconcileSubmission(input, context) {
      const target = object(input.plan.target);
      if (typeof target?.repo !== 'string' || await actor(context) !== target.actor) return unknown();
      const marker = `helmsman-feedback:${input.id}:${input.contentHash}`;
      const response = await context.http.request(get('/search/issues', { q: `repo:${target.repo} is:issue in:body "${marker}"`, per_page: '100' }));
      const search = object(response.body);
      if (response.status !== 200 || search?.incomplete_results !== false || search.total_count !== 1 || !Array.isArray(search.items) || search.items.length !== 1) return unknown();
      const candidate = object(search.items[0]);
      if (!Number.isSafeInteger(candidate?.number) || Number(candidate?.number) < 1) return unknown();
      const detail = await context.http.request(get(`/repos/${target.repo}/issues/${candidate!.number}`));
      return detail.status === 200 ? receipt(detail.body, input) ?? unknown() : unknown();
    },
  };
}

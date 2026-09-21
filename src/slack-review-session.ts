import { requestSlackReview, SlackReviewRequestError, type SlackReviewResult } from './data/slackReview';
import { term } from './logic/terminology';

export interface SlackReviewIdentity { repo: string; number: number; }
interface SlackRequest { requestId: string; pending: boolean; error?: string; result?: SlackReviewResult; }
const key = (identity: SlackReviewIdentity) => JSON.stringify([identity.repo, identity.number]);
export class SlackReviewSession {
  private disposed = false;
  private readonly slack = new Map<string, SlackRequest>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { if (!this.disposed) for (const listener of [...this.listeners]) listener(); }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
  async request(identity: SlackReviewIdentity): Promise<void> {
    if (this.disposed) return;
    const id = key(identity); const previous = this.slack.get(id); if (previous?.pending || previous?.result) return;
    const state: SlackRequest = { requestId: previous?.requestId || crypto.randomUUID(), pending: true }; this.slack.set(id, state); this.notify();
    try { state.result = await requestSlackReview(identity.repo, identity.number, state.requestId); }
    catch (error) { state.error = error instanceof Error ? error.message : 'Slack request failed. Check the channel before retrying.'; if (error instanceof SlackReviewRequestError && !error.uncertain) state.requestId = ''; }
    finally { state.pending = false; this.notify(); }
  }
  paint(root: ParentNode, enabled: boolean): void {
    for (const control of root.querySelectorAll<HTMLElement>('[data-slack-review-control]')) {
      const repo = control.dataset.repo; const number = Number(control.dataset.number); if (!repo || !Number.isSafeInteger(number) || number < 1) continue;
      const state = this.slack.get(key({ repo, number })); const button = control.querySelector<HTMLButtonElement>('[data-slack-review-request]'); const status = control.querySelector<HTMLElement>('.slack-review-result'); if (!button || !status) continue;
      button.disabled = !enabled || Boolean(state?.pending || state?.result); button.title = enabled ? '' : 'Enable Slack integration in Config to request a review.';
      button.textContent = state?.pending ? 'Sending…' : state?.result ? term('reviewRequested') : term('requestSlackReview');
      status.classList.toggle('is-error', Boolean(state?.error)); status.setAttribute('role', state?.error ? 'alert' : 'status'); status.replaceChildren();
      if (state?.error) status.textContent = state.error;
      else if (state?.result) {
        status.textContent = `Sent to #${state.result.channel.replace(/^#/, '')}. `;
        if (state.result.permalink) { const link = document.createElement('a'); link.href = state.result.permalink; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View message ↗'; status.append(link); }
      }
    }
  }
}

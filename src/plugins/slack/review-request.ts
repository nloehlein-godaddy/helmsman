export class SlackReviewError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  constructor(message: string, status: number, uncertain = false) { super(message); this.name = 'SlackReviewError'; this.status = status; this.uncertain = uncertain; }
}

import type { DashboardSnapshot } from './mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
  repos: string[];
  selectedRepo: string | null;
  jiraBaseUrl: string | null;
  jiraEnabled?: boolean;
}

export const POLL_MS: number = 5 * 60_000;
export const LOCAL_POLL_MS: number = 30_000;

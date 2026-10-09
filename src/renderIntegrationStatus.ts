import type { IntegrationNavigationStatus } from './data/integration-status';
import { escapeHtml as esc } from './logic/html';

export function integrationStatusDescription(kind: 'jira' | 'github', repo: string | null, status: IntegrationNavigationStatus['jira']): string {
  const name = kind === 'jira' ? 'Jira' : 'GitHub';
  if (status === 'checking') return `${name}: checking connection`;
  if (status === 'not-configured') return `${name}: no connection configured${repo ? ` for ${repo}` : ''}`;
  if (status === 'unknown') return `${name}: connection status unknown. Open settings to check configuration.`;
  if (status === 'unavailable') return `${name}: connection could not be verified. Open settings to check configuration and access.`;
  return kind === 'jira' ? `${name}: account authenticated. Task access has not been checked.`
    : repo ? `${name}: authenticated; pull requests accessible for ${repo}.` : `${name}: account authenticated. Select a galleon to check pull request access.`;
}

export function renderIntegrationStatus(kind: 'jira' | 'github', status: IntegrationNavigationStatus['jira'], description: string): string {
  const shapes = {
    available: '<circle cx="8" cy="8" r="6.25"/><path d="m4.75 8 2 2 4.5-4.5"/>',
    unavailable: '<path d="M8 1.5 15 14H1L8 1.5Z"/><path d="M8 5.5v4M8 11.5v.5"/>',
    'not-configured': '<circle cx="8" cy="8" r="6.25"/><path d="m3.5 12.5 9-9"/>',
    unknown: '<circle cx="8" cy="8" r="6.25"/><path d="M6 6a2 2 0 0 1 4 0c0 1.5-2 1.5-2 3M8 11.5v.5"/>',
    checking: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4v4l2.5 1.5"/>',
  };
  return `<svg class="integration-status-icon" data-integration-status="${kind}" data-status="${status}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[status]}</svg><span class="sr-only" id="${kind}-integration-status-description">${esc(description)}</span>`;
}

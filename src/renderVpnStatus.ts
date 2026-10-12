import type { VpnNavigationStatus } from './data/vpn-status';
import { escapeHtml as esc } from './logic/html';

export function vpnStatusDescription(status: VpnNavigationStatus): string {
  if (status.state === 'checking') return 'Company VPN: checking this machine’s connection. Checked once a minute.';
  const name = status.state === 'connected' ? 'Connected' : status.state === 'disconnected' ? 'Disconnected' : 'Unknown';
  const details = 'client' in status
    ? `GlobalProtect: ${status.client}. ${status.network === 'reachable' ? 'Internal endpoint reachable.' : status.network === 'unreachable' ? 'Internal endpoint unreachable; this alone does not prove the VPN is disconnected.' : 'Internal connectivity check not configured.'} Last checked ${new Date(status.checkedAt).toLocaleTimeString()}.`
    : 'Connection could not be verified.';
  return `Company VPN: ${name}. ${details} Checks the machine running Helmsman once a minute.`;
}

export function renderVpnStatus(status: VpnNavigationStatus = { state: 'unknown' }): string {
  const description = vpnStatusDescription(status);
  const glyphs = { connected: '\ue40c', disconnected: '\ue410', unknown: '\ue412', checking: '\ueb44' };
  return `<span class="vpn-status" data-vpn-status data-state="${status.state}" role="img" aria-label="${esc(description)}" tabindex="0" title="${esc(description)}"><span class="vpn-status-icon" data-glyph="${glyphs[status.state]}" aria-hidden="true"></span></span>`;
}

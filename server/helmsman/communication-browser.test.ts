import { describe, expect, it, vi } from 'vitest';
import { createCommunicationBrowserSession, type CommunicationBrowserTransport } from './communication-browser';

function fixture() {
  const controller = new AbortController();
  const transport = vi.fn<CommunicationBrowserTransport>(async args => args.includes('tree') ? JSON.stringify({ active: { surface_ref: 'surface:9' }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: 'surface:9', surfaces: [
    { ref: 'surface:1', type: 'browser', url: 'https://app.slack.com/client/T123/C123' },
    { ref: 'surface:2', type: 'browser', url: 'https://app.slack.com/client/T999/C999' },
    { ref: 'surface:9', type: 'terminal' },
  ] }] }] }] }) : 'true');
  const session = createCommunicationBrowserSession({ workspace: 'T123', surface: null, signal: controller.signal, transport });
  return { controller, transport, session };
}

describe('bounded communication browser execution', () => {
  it('allows workspace discovery and prior-focus restoration but rejects another workspace before execution', async () => {
    const { session, transport } = fixture(); await session.tree();
    await session.focus({ surface: 'surface:9' });
    await expect(session.evaluate({ surface: 'surface:2', script: 'JSON.stringify(true)' })).rejects.toThrow('retained connection');
    expect(transport.mock.calls.some(([args]) => args[0] === 'browser')).toBe(false);
    await session.evaluate({ surface: 'surface:1', script: 'JSON.stringify(true)' });
    const script = transport.mock.calls.at(-1)?.[0][3];
    expect(script).toContain("u.origin !== 'https://app.slack.com'");
    expect(script).toContain("'/client/T123/'");
  });
  it('uses bounded cmux wait arguments and checks the workspace before a UI primitive', async () => {
    const { session, transport } = fixture(); await session.tree();
    await session.wait({ surface: 'surface:1', selector: '[role="combobox"]', timeoutMs: 10_000 });
    expect(transport.mock.calls.at(-2)?.[0].slice(0, 3)).toEqual(['browser', 'surface:1', 'eval']);
    expect(transport.mock.calls.at(-1)?.[0]).toEqual(['browser', 'surface:1', 'wait', '--selector', '[role="combobox"]', '--timeout-ms', '10000']);
    await expect(session.wait({ surface: 'surface:1', selector: 'body', timeoutMs: 60_000 })).rejects.toThrow('Invalid browser wait');
  });
  it('cancels before any new command and rejects unknown focus targets', async () => {
    const { session, transport, controller } = fixture(); await session.tree();
    await expect(session.focus({ surface: 'surface:999' })).rejects.toThrow('Unknown browser focus');
    controller.abort(); const before = transport.mock.calls.length;
    await expect(session.evaluate({ surface: 'surface:1', script: 'JSON.stringify(true)' })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(before);
  });
});

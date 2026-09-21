import { describe, expect, it, vi } from 'vitest';
import type { NativeTerminalBrowserV1 } from '../../src/plugins/native-terminal';
import { createCommunicationBrowserSession } from './communication-browser';

function fixture() {
  const controller = new AbortController();
  let identity = 'session-1';
  const tree = { active: { surface_ref: 'terminal/restore' }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: 'terminal/restore', surfaces: [
    { ref: 'browser/slack', type: 'browser', url: 'https://app.slack.com/client/T123/C123' },
    { ref: 'browser/other', type: 'browser', url: 'https://app.slack.com/client/T999/C999' },
    { ref: 'terminal/restore', type: 'terminal' },
  ] }] }] }] };
  const browser: NativeTerminalBrowserV1 = {
    tree: vi.fn(async () => tree), focus: vi.fn(async () => {}), evaluate: vi.fn(async () => true),
    click: vi.fn(async () => {}), fill: vi.fn(async () => {}), wait: vi.fn(async () => {}),
  };
  const session = createCommunicationBrowserSession({ workspace: 'T123', surface: null, signal: controller.signal, browser, sessionIdentity: () => identity });
  return { browser, controller, session, replaceSession: () => { identity = 'session-2'; } };
}

describe('bounded communication browser execution', () => {
  it('allows opaque workspace surfaces and prior-focus restoration but rejects another workspace before execution', async () => {
    const { session, browser } = fixture(); await session.tree();
    await session.focus({ surface: 'terminal/restore' });
    await expect(session.evaluate({ surface: 'browser/other', script: 'JSON.stringify(true)' })).rejects.toThrow('retained connection');
    expect(browser.evaluate).not.toHaveBeenCalled();
    await session.evaluate({ surface: 'browser/slack', script: 'JSON.stringify(true)' });
    const input = vi.mocked(browser.evaluate).mock.calls.at(-1)?.[0];
    expect(input?.script).toContain("u.origin !== 'https://app.slack.com'");
    expect(input?.script).toContain("'/client/T123/'");
  });
  it('routes bounded primitives through the provider after checking the workspace', async () => {
    const { session, browser } = fixture(); await session.tree();
    await session.wait({ surface: 'browser/slack', selector: '[role="combobox"]', timeoutMs: 10_000 });
    expect(browser.evaluate).toHaveBeenCalledOnce();
    expect(browser.wait).toHaveBeenCalledWith({ surface: 'browser/slack', selector: '[role="combobox"]', timeoutMs: 10_000 }, expect.any(AbortSignal));
    await expect(session.wait({ surface: 'browser/slack', selector: 'body', timeoutMs: 60_000 })).rejects.toThrow('Invalid browser wait');
  });
  it('cancels before any new primitive and rejects unknown focus targets', async () => {
    const { session, browser, controller } = fixture(); await session.tree();
    await expect(session.focus({ surface: 'missing' })).rejects.toThrow('Unknown browser focus');
    controller.abort();
    await expect(session.evaluate({ surface: 'browser/slack', script: 'JSON.stringify(true)' })).rejects.toThrow();
    expect(browser.evaluate).not.toHaveBeenCalled();
  });
  it.each(['click', 'fill'] as const)('blocks %s when the native session changes after the workspace guard', async method => {
    const f = fixture(); await f.session.tree();
    vi.mocked(f.browser.evaluate).mockImplementationOnce(async () => { f.replaceSession(); return true; });
    const operation = method === 'click'
      ? f.session.click({ surface: 'browser/slack', selector: 'button' })
      : f.session.fill({ surface: 'browser/slack', selector: 'input', value: 'message' });
    await expect(operation).rejects.toThrow('native session changed');
    expect(f.browser[method]).not.toHaveBeenCalled();
  });
});

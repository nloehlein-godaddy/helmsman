// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createPluginCleanup } from './cleanup';

it.each([false, true])('bounds self-registering cleanup within a single drain budget (late: %s)', async late => {
  const onError = vi.fn();
  const cleanups = createPluginCleanup({ timeoutMs: 10, onError });
  if (late) await cleanups.dispose();
  let calls = 0;
  const repeat = () => { calls++; cleanups.register(repeat); };
  cleanups.register(repeat);
  if (late) await new Promise(resolve => setTimeout(resolve, 30));
  else await cleanups.dispose();
  expect(calls).toBeGreaterThan(0);
  expect(onError).toHaveBeenCalledWith(late);
  const completedCalls = calls;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toBe(completedCalls);
});

it('keeps post-disposal cleanup best effort without reopening completed disposal', async () => {
  const onError = vi.fn();
  const cleanups = createPluginCleanup({ timeoutMs: 10, onError });
  const disposed = cleanups.dispose();
  await disposed;
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  cleanups.register(() => { begin(); return new Promise(() => {}); });
  expect(cleanups.dispose()).toBe(disposed);
  await disposed;
  await started;
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(true));
});

it('continues original cleanup callbacks after one times out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const onError = vi.fn();
    const cleanups = createPluginCleanup({ timeoutMs: 20, onError });
    const finish = vi.fn();
    cleanups.register(finish);
    cleanups.register(() => new Promise(() => {}));
    const disposed = cleanups.dispose();
    await vi.advanceTimersByTimeAsync(20);
    await disposed;
    expect(finish).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

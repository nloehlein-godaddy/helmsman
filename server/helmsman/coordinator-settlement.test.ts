// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { acknowledgeCoordinatorSettlement, beginCoordinatorStage } from './coordinator-settlement';

const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
afterEach(() => {
  if (originalSend) Object.defineProperty(process, 'send', originalSend);
  else delete process.send;
  if (originalConnected) Object.defineProperty(process, 'connected', originalConnected);
  else Reflect.deleteProperty(process, 'connected');
});

function channel() {
  const send = vi.fn((_message, callback) => { callback(null); return true; });
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  return send;
}

it('acknowledges only after every started stage has completed cleanup', async () => {
  const send = channel();
  const first = beginCoordinatorStage();
  const second = beginCoordinatorStage();
  try {
    await acknowledgeCoordinatorSettlement();
    expect(send).not.toHaveBeenCalled();
    first(); first();
    await acknowledgeCoordinatorSettlement();
    expect(send).not.toHaveBeenCalled();
    second();
    await acknowledgeCoordinatorSettlement();
    expect(send).toHaveBeenCalledWith({ kind: 'helmsman-coordinator-settled', version: 1 }, expect.any(Function));
  } finally { first(); second(); }
});

it('does not invent an acknowledgement if the owner disconnected', async () => {
  const send = channel();
  Object.defineProperty(process, 'connected', { configurable: true, value: false });
  await acknowledgeCoordinatorSettlement();
  expect(send).not.toHaveBeenCalled();
});

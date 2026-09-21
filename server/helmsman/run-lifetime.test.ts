import { expect, it } from 'vitest';
import { createRunLifetime } from './run-lifetime';

it('cancels retained provider loading with an admission stopped before handoff', () => {
  const lifetime = createRunLifetime();
  lifetime.stop();
  expect(lifetime.admissionSignal.aborted).toBe(true);
  expect(lifetime.providerSignal.aborted).toBe(true);
  expect(() => lifetime.startExecution()).toThrow();
  lifetime.dispose();
});

it('keeps retained execution observers alive after Stop until disposal', () => {
  const lifetime = createRunLifetime();
  lifetime.startExecution();
  lifetime.stop();
  expect(lifetime.admissionSignal.aborted).toBe(true);
  expect(lifetime.providerSignal.aborted).toBe(false);
  lifetime.dispose();
  expect(lifetime.providerSignal.aborted).toBe(true);
});

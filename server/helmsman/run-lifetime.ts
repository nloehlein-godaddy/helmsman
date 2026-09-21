export function createRunLifetime() {
  const admission = new AbortController();
  const providers = new AbortController();
  const cancelPreparation = () => providers.abort(admission.signal.reason);
  admission.signal.addEventListener('abort', cancelPreparation, { once: true });
  return {
    admissionSignal: admission.signal,
    providerSignal: providers.signal,
    stop() { admission.abort(); },
    startExecution() {
      admission.signal.throwIfAborted();
      admission.signal.removeEventListener('abort', cancelPreparation);
    },
    dispose() {
      admission.signal.removeEventListener('abort', cancelPreparation);
      providers.abort();
    },
  };
}

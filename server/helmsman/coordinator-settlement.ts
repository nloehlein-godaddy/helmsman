const pendingStages = new Set<symbol>();

export function beginCoordinatorStage(): () => void {
  const stage = Symbol();
  pendingStages.add(stage);
  return () => { pendingStages.delete(stage); };
}

export async function acknowledgeCoordinatorSettlement(): Promise<void> {
  if (pendingStages.size || !process.send || !process.connected) return;
  await new Promise<void>((resolve, reject) => {
    process.send!({ kind: 'helmsman-coordinator-settled', version: 1 }, error => error ? reject(error) : resolve());
  });
}

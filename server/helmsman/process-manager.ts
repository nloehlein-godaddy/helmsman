interface Entry {
  repo: string;
  stop: () => void;
}

export interface DurableReservations {
  reservations(): readonly { runId: string; repo: string; reason?: string }[];
}

export class ProcessManager {
  private readonly maxConcurrency: number;
  private readonly entries: Map<string, Entry> = new Map();
  private readonly durable?: DurableReservations;
  private readonly galleonMaximum: (repo: string) => number;

  constructor(maxConcurrency: number, durable?: DurableReservations, galleonMaximum: (repo: string) => number = () => 1) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('Invalid maximum concurrency');
    this.maxConcurrency = maxConcurrency;
    this.durable = durable;
    this.galleonMaximum = galleonMaximum;
  }

  private reserved(): Map<string, { repo: string }> {
    const all = new Map<string, { repo: string }>(this.entries);
    for (const reservation of this.durable?.reservations() ?? []) {
      if (!reservation || typeof reservation.runId !== 'string' || !reservation.runId || typeof reservation.repo !== 'string' || !reservation.repo) throw new Error('Invalid durable execution reservation');
      all.set(reservation.runId, reservation);
    }
    return all;
  }

  canStart(repo: string): { ok: true } | { ok: false; reason: string } {
    const reserved = this.reserved();
    if (reserved.size >= this.maxConcurrency) return { ok: false, reason: 'max concurrency reached' };
    const maximum = this.galleonMaximum(repo);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20) throw new Error('Invalid galleon execution maximum');
    if ([...reserved.values()].filter(entry => entry.repo.toLowerCase() === repo.toLowerCase()).length >= maximum) {
      return { ok: false, reason: maximum === 1 ? `a run is already active for ${repo}` : `execution capacity is reserved for ${repo}` };
    }
    return { ok: true };
  }

  add(runId: string, repo: string, stop: () => void): void {
    this.entries.set(runId, { repo, stop });
  }

  remove(runId: string): void {
    this.entries.delete(runId);
  }

  stop(runId: string): boolean {
    const entry: Entry | undefined = this.entries.get(runId);
    if (!entry) return false;
    entry.stop();
    return true;
  }

  hasRun(runId: string): boolean {
    return this.reserved().has(runId);
  }

  hasAttached(runId: string): boolean {
    return this.entries.has(runId);
  }

  activeRepos(): string[] {
    return [...new Set(Array.from(this.reserved().values()).map((e) => e.repo))];
  }

  count(): number {
    return this.reserved().size;
  }
}

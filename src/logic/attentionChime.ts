export interface AttentionAudio {
  readonly ready: boolean;
  unlock(): Promise<void>;
  play(current: () => boolean): Promise<boolean>;
  stop(): void;
  dispose(): void;
}

export class AttentionChime implements AttentionAudio {
  private context: AudioContext | null = null;
  private disposed = false;
  private readonly tones = new Set<OscillatorNode>();
  get ready(): boolean { return !this.disposed && this.context?.state === 'running'; }
  async unlock(): Promise<void> {
    if (this.disposed || typeof window.AudioContext !== 'function') return;
    try {
      this.context ??= new window.AudioContext({ latencyHint: 'interactive' });
      if (this.context.state === 'suspended') await this.context.resume();
    } catch { return; }
  }
  async play(current: () => boolean): Promise<boolean> {
    const context = this.context;
    if (!context || this.disposed || !current()) return false;
    try {
      if (context.state === 'suspended') await context.resume();
      if (this.disposed || context.state !== 'running' || !current()) return false;
      const start = context.currentTime;
      const gain = context.createGain(); gain.connect(context.destination);
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.045, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      const tone = context.createOscillator(); tone.type = 'sine'; tone.frequency.setValueAtTime(660, start);
      tone.frequency.setValueAtTime(880, start + 0.12); tone.connect(gain); this.tones.add(tone);
      tone.onended = () => { this.tones.delete(tone); tone.disconnect(); gain.disconnect(); };
      tone.start(start); tone.stop(start + 0.3); return true;
    } catch { return false; }
  }
  stop(): void { for (const tone of this.tones) { try { tone.stop(); } catch { continue; } } this.tones.clear(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.stop(); void this.context?.close().catch(() => {}); this.context = null; }
}

// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstructionDeliveryUnknownError, instructionDirectory, readInstructions, sendInstruction, startInstructionEndpoint } from './instruction-channel';

const directories: string[] = [];
const endpoints: { close(): Promise<void> }[] = [];
const identity = { runId: 'test-run', attempt: 1, channelId: randomUUID() };
function directory() { const path = mkdtempSync(join(tmpdir(), 'helmsman-instructions-')); directories.push(path); return instructionDirectory(path, identity.runId, identity.attempt, identity.channelId); }
async function start(path: string, deliver: (text: string, id: string) => Promise<void>, stage = 'implement') {
  endpoints.push(await startInstructionEndpoint({ ...identity, directory: path, provider: 'fixture/codex', protocol: 'codex-app-server', stage }, deliver));
  return (await readInstructions(path, true)).targets.find(target => target.stage === stage)!;
}
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('live instruction delivery', () => {
  it('preserves Unicode even when HTTP chunks split a multibyte character', async () => {
    const path = directory();
    const deliver = vi.fn(async () => {});
    const target = await start(path, deliver);
    const id = randomUUID();
    const text = 'Check café and 🚢';
    const body = Buffer.from(JSON.stringify({ id, text }));
    const offset = body.indexOf(Buffer.from('é')) + 1;
    const socketPath = join(tmpdir(), `hm-${createHash('sha256').update(resolve(path)).update(target.id).digest('hex').slice(0, 32)}.sock`);
    await new Promise<void>((done, reject) => {
      const req = request({ socketPath, method: 'POST', path: '/', headers: { 'X-Helmsman-Instruction-Channel': `${identity.runId}:${identity.attempt}:${identity.channelId}` } }, res => { res.resume(); res.once('end', done); });
      req.once('error', reject);
      req.write(body.subarray(0, offset));
      setTimeout(() => req.end(body.subarray(offset)), 20);
    });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(text, id);
    expect((await sendInstruction(path, { id, targetId: target.id, text })).status).toBe('delivered');
  });
  it('records sending before provider acknowledgment and delivers duplicate request IDs only once', async () => {
    const path = directory();
    let acknowledge!: () => void;
    const deliver = vi.fn(() => new Promise<void>(done => { acknowledge = done; }));
    const target = await start(path, deliver);
    const input = { id: randomUUID(), targetId: target.id, text: 'Preserve the existing API.' };
    const first = sendInstruction(path, input);
    await vi.waitFor(async () => expect((await readInstructions(path, true)).instructions[0]?.status).toBe('sending'));
    const duplicate = sendInstruction(path, input);
    acknowledge();
    expect((await first).status).toBe('sending');
    await duplicate;
    await vi.waitFor(async () => expect((await readInstructions(path, true)).instructions[0]?.status).toBe('delivered'));
    expect(deliver).toHaveBeenCalledExactlyOnceWith(input.text, input.id);
    await endpoints[0]!.close();
    expect((await sendInstruction(path, input)).status).toBe('delivered');
    expect((await readInstructions(path, true)).available).toBe(false);
    expect((await readInstructions(path, false)).instructions[0]?.status).toBe('delivered');
  });

  it('distinguishes rejected instructions from lost acknowledgments', async () => {
    const path = directory();
    const rejected = await start(path, async () => { throw new Error('The turn has finished.'); }, 'review 1');
    const uncertain = await start(path, async () => { throw new InstructionDeliveryUnknownError('Acknowledgment lost.'); }, 'review 2');
    await sendInstruction(path, { id: randomUUID(), targetId: rejected.id, text: 'Check compatibility.' });
    await sendInstruction(path, { id: randomUUID(), targetId: uncertain.id, text: 'Check compatibility.' });
    await vi.waitFor(async () => expect((await readInstructions(path, true)).instructions.map(item => item.status)).toEqual(['failed', 'unknown']));
    expect((await readInstructions(path, true)).targets).toHaveLength(2);
  });

  it('never forwards an old-stage target to a new agent and preserves history', async () => {
    const path = directory();
    const original = await start(path, async () => {});
    await sendInstruction(path, { id: randomUUID(), targetId: original.id, text: 'Keep scope narrow.' });
    await endpoints[0]!.close();
    const deliver = vi.fn(async () => {});
    const current = await start(path, deliver, 'fix');
    await expect(sendInstruction(path, { id: randomUUID(), targetId: original.id, text: 'Old instruction' })).rejects.toThrow('finished');
    expect(deliver).not.toHaveBeenCalled();
    const snapshot = await readInstructions(path, true);
    expect(snapshot.targets.map(target => target.id)).toEqual([current.id]);
    expect(snapshot.instructions[0]?.text).toBe('Keep scope narrow.');
  });

  it('rejects invalid and oversized input before contacting an agent', async () => {
    const path = directory();
    const deliver = vi.fn(async () => {});
    const target = await start(path, deliver);
    for (const input of [null, {}, { id: randomUUID(), targetId: '../other', text: 'hi' },
      { id: randomUUID(), targetId: target.id, text: ' ' }, { id: randomUUID(), targetId: target.id, text: 'x'.repeat(8001) }]) {
      await expect(sendInstruction(path, input)).rejects.toMatchObject({ status: 400 });
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(() => instructionDirectory(path, '../another-run', 1, identity.channelId)).toThrow('Invalid instruction');
  });

  it('rejects reuse of a message ID with different text', async () => {
    const path = directory();
    const deliver = vi.fn(async () => {});
    const target = await start(path, deliver);
    const input = { id: randomUUID(), targetId: target.id, text: 'First instruction' };
    await sendInstruction(path, input);
    await expect(sendInstruction(path, { ...input, text: 'Different instruction' })).rejects.toThrow('different instruction');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('rejects endpoint records copied to another attempt or channel', async () => {
    const path = directory(); const deliver = vi.fn(async () => {}); const original = await start(path, deliver);
    for (const suffix of [`2-${identity.channelId}`, `1-${randomUUID()}`]) {
      const other = join(path, '..', suffix); mkdirSync(other, { recursive: true });
      copyFileSync(join(path, `${original.id}.json`), join(other, `${original.id}.json`));
      expect((await readInstructions(other, true)).targets).toEqual([]);
      await expect(sendInstruction(other, { id: randomUUID(), targetId: original.id, text: 'Stale update' })).rejects.toThrow('no longer available');
    }
    expect(deliver).not.toHaveBeenCalled();
  });

  it('continues checking pending acknowledgements after the run stops accepting instructions', async () => {
    const path = directory(); let acknowledge!: () => void;
    const endpoint = await start(path, () => new Promise<void>(resolve => { acknowledge = resolve; }));
    await sendInstruction(path, { id: randomUUID(), targetId: endpoint.id, text: 'Final update' });
    expect(await readInstructions(path, false)).toMatchObject({ available: false, targets: [], instructions: [{ status: 'sending' }] });
    acknowledge();
    await vi.waitFor(async () => expect((await readInstructions(path, false)).instructions[0]?.status).toBe('delivered'));
  });
});

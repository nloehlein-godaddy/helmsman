import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WRAPPER = join(__dirname, 'run-wrapper.mjs');

describe.skipIf(process.platform === 'win32')('run-wrapper', () => {
  it.each([true, undefined])('records feedback CLI failure after settled IPC (explicit coordinator: %s)', coordinator => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-feedback-'));
    try {
      const specPath = join(dir, 'spec.json'); const logPath = join(dir, 'run.log'); const exitPath = join(dir, 'run.exit');
      const identity = { runId: 'feedback-run', launchId: 'feedback-launch', attempt: 1 };
      writeFileSync(specPath, JSON.stringify({ ...identity, cmd: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), join(__dirname, 'feedback-update-cli.ts')], cwd: dir, logPath, exitPath,
        receiptPath: join(dir, 'receipt.json'), ...(coordinator ? { coordinator } : {}) }));
      const wrapper = spawnSync(process.execPath, [WRAPPER, specPath], { encoding: 'utf8', timeout: 15_000 });
      expect(wrapper.error).toBeUndefined(); expect(wrapper.status).toBe(0);
      expect(readFileSync(logPath, 'utf8')).toContain('Feedback worker input is required');
      expect(JSON.parse(readFileSync(exitPath, 'utf8'))).toMatchObject({ ...identity, exitCode: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires inferred feedback coordinators to acknowledge their child stages before writing a receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-feedback-unsettled-'));
    try {
      const worker = join(dir, 'feedback-update-cli.js'); const specPath = join(dir, 'spec.json');
      const logPath = join(dir, 'run.log'); const exitPath = join(dir, 'run.exit');
      writeFileSync(worker, 'process.exit(0);');
      writeFileSync(specPath, JSON.stringify({ cmd: process.execPath, args: [worker], cwd: dir, logPath, exitPath }));
      const wrapper = spawnSync(process.execPath, [WRAPPER, specPath], { encoding: 'utf8', timeout: 15_000 });
      expect(wrapper.error).toBeUndefined(); expect(wrapper.status).toBe(1);
      expect(existsSync(exitPath)).toBe(false);
      expect(readFileSync(logPath, 'utf8')).toContain('coordinator stage settlement is unknown');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('captures stdout+stderr to the log and the exit code to the sentinel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: 'node', args: ['-e', 'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(5)'], cwd: dir, logPath, exitPath }));
    spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
    expect(readFileSync(logPath, 'utf8')).toContain('out');
    expect(readFileSync(logPath, 'utf8')).toContain('err');
    expect(readFileSync(logPath, 'utf8')).toContain('run-wrapper: agent exited with code 5');
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('5');
  });

  it.each([false, true])('preserves durable signal receipts when diagnostic logging fails: %s', unavailableLog => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-signal-'));
    try {
      const specPath = join(dir, 'spec.json'); const logPath = join(dir, 'run.log'); const exitPath = join(dir, 'run.exit');
      const identity = { runId: 'signal-run', launchId: 'signal-launch', attempt: 1 };
      const script = unavailableLog
        ? 'const fs=require("node:fs");const log=process.argv[1];fs.unlinkSync(log);fs.mkdirSync(log);process.kill(process.pid,"SIGTERM");'
        : 'process.kill(process.pid,"SIGTERM");';
      writeFileSync(specPath, JSON.stringify({ ...identity, cmd: process.execPath, args: ['-e', script, logPath], cwd: dir, logPath, exitPath,
        receiptPath: join(dir, 'receipt.json') }));
      const wrapper = spawnSync(process.execPath, [WRAPPER, specPath], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
      expect(wrapper.error).toBeUndefined(); expect(wrapper.status).toBe(0);
      expect(JSON.parse(readFileSync(exitPath, 'utf8'))).toMatchObject({ ...identity, exitCode: 1 });
      if (!unavailableLog) expect(readFileSync(logPath, 'utf8')).toContain('run-wrapper: agent terminated by signal SIGTERM');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes exit 127 and logs the error when the command cannot be spawned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: 'definitely-not-a-real-binary-xyz', args: [], cwd: dir, logPath, exitPath }));
    spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
    expect(existsSync(exitPath)).toBe(true);
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('127');
  });
});

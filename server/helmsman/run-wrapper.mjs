#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from 'node:fs';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const coordinator = spec.coordinator === true || [spec.cmd, ...(spec.args ?? [])].some(value =>
  typeof value === 'string' && /(?:^|[\\/])(?:pre-pr-cli|docker-review-cli|feedback-update-cli)\.[jt]s$/.test(value));
if (process.argv[3] === '--supervise') {
  supervise();
} else {
  runWrapper();
}

function supervise() {
  if (!process.send || process.platform === 'win32') throw new Error('Local worker supervision requires POSIX process groups and an IPC owner');
  let stopping = false;
  let finished = false;
  let timer;
  const terminate = signal => {
    if (stopping) return;
    stopping = true;
    if (!coordinator) timer = setTimeout(() => settle(1), 5000);
    process.kill(-process.pid, signal);
  };
  const settle = (code, settled = true) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const killGroup = () => process.kill(-process.pid, 'SIGKILL');
    if (process.connected) process.send({ exitCode: code, settled }, killGroup);
    else killGroup();
  };
  process.on('SIGTERM', () => terminate('SIGTERM'));
  process.on('SIGINT', () => terminate('SIGINT'));
  process.on('disconnect', () => terminate('SIGTERM'));
  const fd = openSync(spec.logPath, 'a');
  let acknowledged = false;
  const worker = spawn(spec.cmd, spec.args ?? [], { cwd: spec.cwd, stdio: coordinator ? ['ignore', fd, fd, 'ipc'] : ['ignore', fd, fd] });
  worker.on('message', message => {
    if (message?.kind === 'helmsman-coordinator-settled' && message.version === 1) acknowledged = true;
  });
  worker.once('exit', (code, signal) => {
    try {
      if (signal) writeFileSync(spec.logPath, `run-wrapper: agent terminated by signal ${signal}\n`, { flag: 'a' });
      else if (code !== 0) writeFileSync(spec.logPath, `run-wrapper: agent exited with code ${code ?? 1}\n`, { flag: 'a' });
    } catch {}
    settle(code ?? 1, !coordinator || acknowledged && code !== null);
  });
  worker.once('error', error => {
    try { writeFileSync(spec.logPath, `run-wrapper: cannot start ${spec.cmd}: ${error.message}\n`, { flag: 'a' }); } catch {}
    if (!worker.pid) settle(127);
    else terminate('SIGTERM');
  });
}

function runWrapper() {
  const durable = spec.launchId !== undefined;
  let receipt;
  if (durable) {
    if (!/^[a-z\d_-]{1,128}$/i.test(spec.launchId) || !/^[a-z\d_-]{1,128}$/i.test(spec.runId)
      || !Number.isSafeInteger(spec.attempt) || spec.attempt < 1 || typeof spec.receiptPath !== 'string' || !spec.receiptPath) throw new Error('Invalid durable wrapper identity');
    let processStart = null;
    try {
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
        processStart = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
      } else if (process.platform === 'darwin') {
        processStart = `darwin:${execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 }).trim()}`;
      } else if (process.platform === 'win32') {
        processStart = `win32:${execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 5000 }).trim()}`;
      }
    } catch {}
    receipt = { version: 1, runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, pid: process.pid, processStart };
    const temporary = `${spec.receiptPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, spec.receiptPath); }
    finally { unlinkSync(temporary); }
  }

  function finish(code) {
    if (receipt) {
      const temporary = `${spec.exitPath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...receipt, exitCode: code }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, spec.exitPath);
    } else writeFileSync(spec.exitPath, String(code));
    process.exit(0);
  }

  if (process.platform === 'win32') {
    writeFileSync(spec.logPath, 'run-wrapper: local worker supervision requires POSIX process groups; no worker was launched\n', { flag: 'a' });
    finish(127);
  }

  let exitCode = 1;
  let settled = !coordinator;
  const child = spawn(process.execPath, [process.argv[1], specPath, '--supervise'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
  child.on('message', message => {
    if (message && typeof message === 'object' && Number.isInteger(message.exitCode) && message.exitCode >= 0 && message.exitCode <= 255) {
      exitCode = message.exitCode;
      settled = message.settled === true;
    }
  });
  child.once('error', error => {
    try { writeFileSync(spec.logPath, `run-wrapper: cannot start supervisor: ${error.message}\n`, { flag: 'a' }); } catch {}
    if (!child.pid) finish(127);
  });
  child.once('exit', () => {
    let reported = false;
    const settle = () => {
      try {
        const inventory = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
        const running = inventory.split('\n').some(line => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === child.pid && state && !state.startsWith('Z');
        });
        if (!running) {
          if (!settled) {
            writeFileSync(spec.logPath, 'run-wrapper: coordinator stage settlement is unknown; withholding terminal receipt\n', { flag: 'a' });
            process.exit(1);
          }
          finish(exitCode);
          return;
        }
      } catch (error) {
        if (!reported) {
          reported = true;
          try { writeFileSync(spec.logPath, `run-wrapper: cannot verify supervisor group settlement: ${error.message}\n`, { flag: 'a' }); } catch {}
        }
      }
      setTimeout(settle, 100);
    };
    settle();
  });
}

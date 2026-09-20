#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from 'node:fs';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
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
const fd = openSync(spec.logPath, 'a');

function finish(code) {
  if (receipt) {
    const temporary = `${spec.exitPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...receipt, exitCode: code }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, spec.exitPath);
  } else writeFileSync(spec.exitPath, String(code));
  process.exit(0);
}

const child = spawn(spec.cmd, spec.args ?? [], { cwd: spec.cwd, stdio: ['ignore', fd, fd] });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
child.on('exit', (code) => {
  finish(code ?? 1);
});
child.on('error', (err) => {
  try { writeFileSync(spec.logPath, `run-wrapper: cannot start ${spec.cmd}: ${err.message}\n`, { flag: 'a' }); } catch {}
  finish(127);
});

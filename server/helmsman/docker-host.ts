import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, readlink, symlink, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HostDiscovery, HostRef, LaunchSpec, RunHost } from './run-host';
import { launchIdentity, readExitEvidence } from './host-evidence';
import { isHostCoordinatorCommand } from './runtime-paths';

export type DockerRun = (argv: string[]) => Promise<{ stdout: string; code: number }>;
const exec = promisify(execFile);
export const dockerRun: DockerRun = async argv => { const [bin, ...args] = argv; const result = await exec(bin!, args); return { stdout: result.stdout, code: 0 }; };

export interface DockerHostOptions { image: string; runtimeRoot: string; wrapperPath: string; run: DockerRun; enabled: boolean; }
const safe = (value: string) => /^[a-z\d_-]{1,128}$/i.test(value);
async function link(path: string, target: string): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); try { const stat = await lstat(path); if (!stat.isSymbolicLink() || await readlink(path) !== target) throw new Error(`Docker output path is occupied: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await symlink(target, path); else if (error instanceof Error && error.message.startsWith('Docker output')) throw error; else throw error; } }

export function dockerHost(options: DockerHostOptions): RunHost {
  const run = options.run;
  async function discover(spec: LaunchSpec, ref?: HostRef): Promise<HostDiscovery> {
    const identity = launchIdentity(spec);
    if (!identity) return { status: 'unknown', reason: 'Legacy Docker launch has no attempt ownership label' };
    let inspected;
    try { inspected = await run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', `helmsman-${identity.launchId}`]); }
    catch (error) {
      const message = String((error as { stderr?: unknown })?.stderr ?? (error instanceof Error ? error.message : error));
      return /No such (?:object|container)/i.test(message)
        ? { status: 'absent', evidence: `Docker reports no container named helmsman-${identity.launchId}` }
        : { status: 'unknown', reason: message };
    }
    if (inspected.code !== 0) return { status: 'unknown', reason: 'Docker ownership inspection failed' };
    const container = JSON.parse(inspected.stdout) as { Id?: unknown; State?: { Running?: unknown; Status?: unknown }; Config?: { Labels?: Record<string, unknown> } } | null;
    if (!container || typeof container.Id !== 'string' || !/^[a-f\d]{12,64}$/i.test(container.Id)
      || container.Config?.Labels?.['helmsman.runId'] !== identity.runId
      || container.Config?.Labels?.['helmsman.launchId'] !== identity.launchId
      || container.Config?.Labels?.['helmsman.attempt'] !== String(identity.attempt)
      || ref && (ref.kind !== 'docker' || ref.containerId !== container.Id)) return { status: 'unknown', reason: 'Docker container ownership does not match this attempt' };
    const owned: HostRef = { kind: 'docker', containerId: container.Id, ownership: identity };
    if (container.State?.Running === true) return { status: 'found', ref: owned, evidence: { ...identity, state: 'running' } };
    if (container.State?.Running !== false || !['exited', 'dead'].includes(String(container.State?.Status))) return { status: 'unknown', reason: 'Docker container has unresolved process state' };
    const exit = await readExitEvidence(spec);
    return exit ? { status: 'found', ref: owned, evidence: { ...identity, state: 'exited', exitCode: exit.exitCode } }
      : { status: 'unknown', reason: 'Stopped Docker container has no matching worker exit receipt' };
  }
  return {
    kind: 'docker',
    discover,
    async launch(spec: LaunchSpec): Promise<HostRef> {
      if (!options.enabled) throw new Error('Docker run host is disabled');
      if (!safe(spec.runId) || !options.image) throw new Error('Invalid Docker run specification');
      const identity = launchIdentity(spec);
      if (isHostCoordinatorCommand(spec)) {
        throw new Error('Pre-PR and Docker review coordinators must execute on the host');
      }
      const git = await lstat(join(spec.cwd, '.git')).catch(() => null);
      if (git?.isFile()) throw new Error('Docker host cannot run a linked Git worktree; provision a standalone clone first.');
      const runtime = `${options.runtimeRoot}/${identity?.launchId ?? spec.runId}.runtime`;
      const name = `helmsman-${identity?.launchId ?? spec.runId}`;
      if (identity) {
        const existing = await discover(spec);
        if (existing.status === 'found') return existing.ref;
        if (existing.status === 'unknown') throw new Error(existing.reason);
      }
      let existing: unknown;
      try { if (!identity) {
        const inspected = await run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', name]);
        if (inspected.code !== 0) throw new Error('Could not inspect the existing Docker run');
        existing = JSON.parse(inspected.stdout);
      }
      } catch (error) {
        const message = String((error as { stderr?: unknown })?.stderr ?? (error instanceof Error ? error.message : error));
        if (!/No such (?:object|container)/i.test(message)) throw error;
      }
      if (existing !== undefined) {
        const container = existing as { Id?: unknown; State?: { Running?: unknown; Status?: unknown }; Config?: { Labels?: Record<string, unknown> } } | null;
        if (!container || typeof container.Id !== 'string' || !/^[a-f\d]{12,64}$/i.test(container.Id)
          || container.Config?.Labels?.['helmsman.runId'] !== spec.runId || typeof container.State?.Running !== 'boolean') {
          throw new Error('Existing Docker container does not belong to this run');
        }
        if (container.State.Running) return { kind: 'docker', containerId: container.Id };
        if (!['created', 'exited', 'dead'].includes(String(container.State.Status))) throw new Error('Existing Docker container is not stopped');
        const removed = await run(['docker', 'rm', container.Id]);
        if (removed.code !== 0) throw new Error('Could not reclaim the stopped Docker run');
      }
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const staged = { ...spec, cwd: '/worktree', logPath: '/runtime/worker.log', exitPath: '/runtime/worker.exit', specPath: '/runtime/spec.json', ...(identity ? { receiptPath: '/runtime/worker.receipt' } : {}) };
      await writeFile(spec.specPath, JSON.stringify(spec), { mode: 0o600 });
      await copyFile(options.wrapperPath, join(runtime, 'run-wrapper.mjs'));
      await writeFile(join(runtime, 'spec.json'), JSON.stringify(staged), { mode: 0o600 });
      await writeFile(join(runtime, 'worker.log'), '', { mode: 0o600, ...(identity ? { flag: 'ax' } : {}) }).catch(error => { if (!identity || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      if (!identity) await rm(join(runtime, 'worker.exit'), { force: true });
      await link(spec.logPath, join(runtime, 'worker.log'));
      await link(spec.exitPath, join(runtime, 'worker.exit'));
      if (identity) await link(identity.receiptPath, join(runtime, 'worker.receipt'));
      const result = await run(['docker', 'run', '--detach', '--name', name, '--label', `helmsman.runId=${spec.runId}`,
        ...(identity ? ['--label', `helmsman.launchId=${identity.launchId}`, '--label', `helmsman.attempt=${identity.attempt}`] : []), '--workdir', '/worktree',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--mount', `type=bind,src=${spec.cwd},dst=/worktree`, '--mount', `type=bind,src=${runtime},dst=/runtime`,
        '--env', 'HELMSMAN_RUNTIME=/runtime', '--network', 'none', '--entrypoint', 'node', options.image, '/runtime/run-wrapper.mjs', '/runtime/spec.json']);
      const containerId = result.stdout.trim();
      if (result.code !== 0 || !/^[a-f\d]{12,64}$/i.test(containerId)) throw new Error('Docker returned an invalid container identity');
      return { kind: 'docker', containerId, ...(identity ? { ownership: identity } : {}) };
    },
    async isAlive(ref) {
      if (ref.kind !== 'docker') return false;
      try { const result = await run(['docker', 'inspect', '--format', '{{.State.Running}}', ref.containerId]); return result.stdout.trim() === 'true'; } catch { return false; }
    },
    async stop(ref) {
      if (ref.kind !== 'docker') return;
      if (ref.ownership) {
        const result = await run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', ref.containerId]);
        const container = JSON.parse(result.stdout) as { Id?: unknown; Config?: { Labels?: Record<string, unknown> } } | null;
        if (result.code !== 0 || container?.Id !== ref.containerId || container.Config?.Labels?.['helmsman.runId'] !== ref.ownership.runId
          || container.Config?.Labels?.['helmsman.launchId'] !== ref.ownership.launchId || container.Config?.Labels?.['helmsman.attempt'] !== String(ref.ownership.attempt)) throw new Error('Refusing to stop an unverified Docker container');
        const stopped = await run(['docker', 'stop', '--time', '10', ref.containerId]);
        if (stopped.code !== 0) throw new Error('Docker stop failed; process ownership remains unresolved');
        return;
      }
      try { await run(['docker', 'stop', '--time', '10', ref.containerId]); } catch {}
    },
  };
}

export async function hasDocker(run: DockerRun = dockerRun): Promise<boolean> { try { return (await run(['docker', 'version', '--format', '{{.Server.Version}}'])).code === 0; } catch { return false; } }

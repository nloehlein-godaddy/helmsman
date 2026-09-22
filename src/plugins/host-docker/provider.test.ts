// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionHostStageInputV1 } from '@helmsman/plugin-sdk';
import { createDockerExecutionHost, type DockerCommandRunner } from './provider';
import { boundedExecutionHostProvider } from '../../../server/helmsman/execution-host-providers';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-host-docker-test-'));
  roots.push(root);
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await writeFile(join(cwd, '.git', 'config'), '[core]\nfsmonitor = /evil\n');
  const calls: readonly string[][] = [];
  const run = vi.fn<DockerCommandRunner>().mockResolvedValue({ stdout: '', code: 0 });
  const digest = `sha256:${'a'.repeat(64)}`;
  const input: ExecutionHostStageInputV1 = {
    version: 1,
    runId: 'run-1',
    repo: 'org/repo',
    cwd,
    runtimeRoot: root,
    gateway: { url: 'http://host.docker.internal:8790/', capability: 'secret-capability' },
    configuration: { image: digest },
    transport: 'openai-responses',
    stage: 'implement',
    skillsPath: null,
    reportPath: join(root, 'report.json'),
    priorReportPath: null,
    reviewOutputPaths: null,
    clarification: null,
  };
  return { root, cwd, run, digest, input, calls };
}

function runtime(args: readonly string[]): string {
  const value = args.find(arg => arg.endsWith('dst=/runtime'));
  const source = value?.match(/src=([^,]+)/)?.[1];
  if (!source) throw new Error('No runtime mount');
  return source;
}

describe('Docker execution host', () => {
  it('resolves a locally built image tag to an immutable image ID', async () => {
    const { run, digest } = await fixture();
    run.mockResolvedValueOnce({ stdout: `${digest}\n`, code: 0 });
    const provider = createDockerExecutionHost({ image: 'example/agent:latest', run });
    await expect(provider.prepareRun({ version: 1, runId: 'run-1', repo: 'org/repo', mode: 'coding' })).resolves.toEqual({ image: digest });
    expect(run).toHaveBeenCalledWith(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'example/agent:latest']);
  });

  it('isolates a stage, renders guest paths and copies bounded output after teardown', async () => {
    const { run, input, cwd } = await fixture();
    const provider = createDockerExecutionHost({ image: 'example/agent:latest', run });
    const render = vi.fn(() => ({ cmd: 'codex', args: ['exec', 'prompt'] }));
    const stage = await provider.prepareStage!(input, render);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ reportPath: '/runtime/report.json' }));
    expect(stage.command.cmd).toBe('docker');
    expect(stage.command.args).toEqual(expect.arrayContaining([
      '--network', expect.stringContaining('-network'),
      `HELMSMAN_CAPABILITY=${input.gateway.capability}`,
      'HELMSMAN_GATEWAY_URL=http://gateway:8080',
      `type=bind,src=${cwd},dst=/worktree`,
      input.configuration && (input.configuration as { image: string }).image,
    ]));
    await writeFile(join(runtime(stage.command.args), 'report.json'), '{"title":"T-1"}');
    await stage.cleanup(true);
    expect(await readFile(input.reportPath!, 'utf8')).toBe('{"title":"T-1"}');
    expect(await readFile(join(cwd, '.git', 'config'), 'utf8')).not.toContain('/evil');
    const operations = run.mock.calls.map(([args]) => args.slice(0, 3).join(' '));
    expect(operations.some(value => value.startsWith('docker rm --force'))).toBe(true);
    expect(operations.some(value => value.startsWith('docker network rm'))).toBe(true);
  });

  it('rejects mutable retained configuration before Docker effects', async () => {
    const { run, input } = await fixture();
    const provider = createDockerExecutionHost({ image: 'example/agent:latest', run });
    await expect(provider.prepareStage!({ ...input, configuration: { image: 'example/agent:latest' } }, () => ({ cmd: 'codex', args: [] })))
      .rejects.toThrow('immutable image digest');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns only the bounded durable identity from a container launch', async () => {
    const { root, cwd, digest } = await fixture();
    const containerId = 'c'.repeat(64);
    const missing = Object.assign(new Error('missing'), { stderr: 'Error: No such container' });
    const run = vi.fn<DockerCommandRunner>(async args => {
      if (args[1] === 'inspect') throw missing;
      if (args[1] === 'run') return { stdout: containerId, code: 0 };
      return { stdout: '', code: 0 };
    });
    const wrapperPath = join(root, 'wrapper.mjs');
    await writeFile(wrapperPath, '');
    const provider = boundedExecutionHostProvider(createDockerExecutionHost({ image: 'example/agent:latest', run }));
    const ref = await provider.launch({
      version: 1,
      runId: 'run-1',
      launchId: 'launch-1',
      attempt: 1,
      receiptPath: join(root, 'launch.receipt'),
      cmd: 'codex',
      args: ['exec'],
      cwd,
      logPath: join(root, 'launch.log'),
      exitPath: join(root, 'launch.exit'),
      specPath: join(root, 'launch.json'),
      wrapperPath,
      coordinator: false,
      configuration: { image: digest },
    });
    expect(ref.identity).toEqual({ runId: 'run-1', launchId: 'launch-1', attempt: 1, receiptPath: join(root, 'launch.receipt') });
    expect(Object.keys(ref.identity)).toEqual(['runId', 'launchId', 'attempt', 'receiptPath']);
    expect(JSON.parse(await readFile(join(root, 'launch-1.docker-runtime/spec.json'), 'utf8')).coordinator).toBe(false);
  });
});

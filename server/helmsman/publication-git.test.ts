// @vitest-environment node
import { execFile } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { publicationGit, type PublicationCommand } from './publication-git';
import { gitBin } from '../test-support/platform';

const exec = promisify(execFile);
const git = gitBin();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const canonical = 'https://github.com/org/repo.git';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-transport-test-')); roots.push(root);
  const cwd = join(root, process.platform === 'win32' ? 'source with spaces' : 'source:with "quotes"');
  await mkdir(cwd);
  const run = async (...args: string[]) => (await exec(git, args, { cwd })).stdout.trim();
  await run('init', '--quiet');
  await run('config', 'user.name', 'Test'); await run('config', 'user.email', 'test@example.invalid');
  await run('commit', '--allow-empty', '--quiet', '-m', 'approved');
  const headSha = await run('rev-parse', 'HEAD');
  const unintended = join(root, 'unintended.git');
  const intended = join(root, 'intended.git');
  await run('init', '--bare', '--quiet', unintended); await run('init', '--bare', '--quiet', intended);
  await run('remote', 'add', 'origin', 'git@github.com:org/repo.git');
  await run('config', `url.${unintended}.insteadOf`, canonical);
  await run('config', `url.${unintended}.pushInsteadOf`, canonical);
  await run('config', 'credential.helper', '!echo source-credential-helper-must-not-run >&2; exit 9');
  await run('config', 'http.extraHeader', 'Authorization: source-secret');
  const global = join(root, 'host.gitconfig');
  await writeFile(global, `[url "${unintended.replaceAll('\\', '\\\\')}"]\n\tinsteadOf = ${canonical}\n\tpushInsteadOf = ${canonical}\n[credential]\n\thelper = !exit 8\n[http]\n\textraHeader = Authorization: global-secret\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${unintended}.insteadOf`, GIT_CONFIG_VALUE_0: canonical,
    GIT_DIR: join(cwd, '.git'), GITHUB_TOKEN: 'unrelated-secret' };
  return { root, cwd, run, headSha, unintended, intended, env };
}
async function withInput(args: readonly string[], context: Parameters<PublicationCommand>[2], input: string): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise(resolve => {
    const child = execFile(git, [...args], context, (error, stdout, stderr) => resolve({ stdout, stderr, failed: Boolean(error) }));
    child.stdin?.end(input);
  });
}

it('isolates actual Git push configuration, URL rewrites, and credentials from source/global/environment config', async () => {
  const f = await fixture();
  expect(await f.run('remote', 'get-url', '--push', 'origin')).toBe('git@github.com:org/repo.git');
  expect(await f.run('ls-remote', '--get-url', canonical)).toBe(f.unintended);
  let transportRoot = '';
  let writes = 0;
  const command: PublicationCommand = async (_cmd, args, context) => {
    const push = args.indexOf('push');
    if (push < 0) return (await exec(git, [...args], context)).stdout.trim();
    writes++;
    const settings = args.slice(0, push);
    const transport = args[args.indexOf('--git-dir') + 1]!;
    transportRoot = dirname(transport);
    expect(context.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(context.env.GIT_DIR).toBeUndefined();
    expect(context.env.GITHUB_TOKEN).toBeUndefined();
    expect(args.slice(push)).toEqual(['push', '--', canonical, `${f.headSha}:refs/heads/agent/run`]);
    await exec(git, [...settings, 'config', 'remote.probe.url', canonical], context);
    expect((await exec(git, [...settings, 'remote', 'get-url', '--push', '--all', 'probe'], context)).stdout.trim()).toBe(canonical);
    const credential = await withInput([...settings, 'credential', 'fill'], context, 'protocol=https\nhost=github.com\npath=org/repo.git\n\n');
    expect(credential.failed, credential.stderr).toBe(false);
    expect(credential.stdout).toContain('password=scoped-test-token');
    for (const input of ['protocol=https\nhost=other.example\npath=org/repo.git\n\n', 'protocol=https\nhost=github.com\npath=other/repo.git\n\n']) {
      const denied = await withInput([...settings, 'credential', 'fill'], context, input);
      expect(denied.failed).toBe(true);
      expect(denied.stdout).not.toContain('scoped-test-token');
    }
    expect(await readFile(join(transport, 'config'), 'utf8')).not.toContain('scoped-test-token');
    return (await exec(git, [...settings, '-c', 'protocol.file.allow=always', 'push', '--', f.intended, `${f.headSha}:refs/heads/agent/run`], context)).stdout.trim();
  };
  await publicationGit({ cwd: f.cwd, repo: 'org/repo', token: 'scoped-test-token', branch: 'agent/run', signal: AbortSignal.timeout(10_000),
    env: f.env, command, action: { kind: 'push', headSha: f.headSha } });
  expect(writes).toBe(1);
  expect(await f.run('--git-dir', f.intended, 'rev-parse', 'refs/heads/agent/run')).toBe(f.headSha);
  await expect(f.run('--git-dir', f.unintended, 'rev-parse', '--verify', 'refs/heads/agent/run')).rejects.toThrow();
  await expect(stat(transportRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['failure', 'abort', 'unsafe-alternate'] as const)('cleans isolated transport on %s before allowing any unrelated writes', async mode => {
  const f = await fixture();
  let transportRoot = '';
  const controller = new AbortController();
  const command: PublicationCommand = async (_cmd, args, context) => {
    if (args[0] === 'init') transportRoot = dirname(args.at(-1)!);
    if (mode === 'unsafe-alternate' && args.includes('--git-path')) return `${f.cwd}\n/other/objects`;
    if (args.includes('push')) {
      if (mode === 'abort') controller.abort();
      context.signal.throwIfAborted();
      throw new Error('Remote failed');
    }
    return (await exec(git, [...args], context)).stdout.trim();
  };
  await expect(publicationGit({ cwd: f.cwd, repo: 'org/repo', token: 'test-token', branch: 'agent/run', signal: controller.signal,
    command, action: { kind: 'push', headSha: f.headSha } })).rejects.toThrow();
  expect(transportRoot).toBeTruthy();
  await expect(stat(transportRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

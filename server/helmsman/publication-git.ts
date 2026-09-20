import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { isGithubRepo } from '../pr-lists';

export interface PublicationCommand { (cmd: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<string>; }
const exec = promisify(execFile);
const credentialHelper = '!f() { [ "$1" = get ] || return 0; publication_protocol=; publication_host=; publication_path=; while IFS= read -r publication_line && [ -n "$publication_line" ]; do case "$publication_line" in protocol=*) publication_protocol=${publication_line#protocol=};; host=*) publication_host=${publication_line#host=};; path=*) publication_path=${publication_line#path=};; esac; done; if [ "$publication_protocol" = https ] && [ "$publication_host" = github.com ] && [ "$publication_path" = "$HELMSMAN_PUBLICATION_REPO.git" ]; then printf "%s\\n" "username=x-access-token" "password=$HELMSMAN_PUBLICATION_TOKEN"; fi; }; f';

export async function publicationGit(input: {
  cwd: string; repo: string; token: string; branch: string; signal: AbortSignal;
  command?: PublicationCommand; env?: NodeJS.ProcessEnv;
  action: { kind: 'read' } | { kind: 'push'; headSha: string };
}): Promise<string> {
  if (!isAbsolute(input.cwd) || !isGithubRepo(input.repo) || typeof input.token !== 'string' || !input.token
    || !/^[a-z\d][a-z\d_./-]{0,254}$/i.test(input.branch) || input.branch.includes('..') || input.branch.endsWith('/')
    || input.action.kind === 'push' && !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(input.action.headSha)) throw new Error('Invalid publication Git target');
  const command: PublicationCommand = input.command ?? (async (cmd, args, options) => (await exec(cmd, [...args], { ...options, timeout: 25_000, maxBuffer: 1024 * 1024 })).stdout.trim());
  const root = await mkdtemp(join(tmpdir(), 'helmsman-publication-git-'));
  try {
    const emptyConfig = join(root, 'empty-config');
    await writeFile(emptyConfig, '', { mode: 0o600, flag: 'wx' });
    const inherited = Object.fromEntries(Object.entries(input.env ?? process.env).filter(([key]) => !/^GIT_/i.test(key) && !['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_ASKPASS'].includes(key)));
    const environment: NodeJS.ProcessEnv = { ...inherited, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const execute = (args: readonly string[], cwd = root, env = environment) => {
      input.signal.throwIfAborted();
      return command('git', args, { cwd, env, signal: input.signal });
    };
    const transport = join(root, 'transport.git');
    await execute(['init', '--bare', '--quiet', '--template=', transport]);
    if (input.action.kind === 'push') {
      const rawObjects = await execute(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], input.cwd);
      if (!isAbsolute(rawObjects) || /[\x00-\x1f\x7f]/.test(rawObjects)) throw new Error('Unsafe publication object store');
      const objects = await realpath(rawObjects);
      if (/[\x00-\x1f\x7f]/.test(objects)) throw new Error('Unsafe publication object store');
      await writeFile(join(transport, 'objects', 'info', 'alternates'), `${JSON.stringify(objects)}\n`, { mode: 0o600, flag: 'wx' });
    }
    const canonical = `https://github.com/${input.repo}.git`;
    const settings = ['--git-dir', transport, '-c', `core.hooksPath=${join(root, 'no-hooks')}`, '-c', 'credential.helper=', '-c', `credential.helper=${credentialHelper}`,
      '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
    const args = input.action.kind === 'read' ? ['ls-remote', '--heads', canonical, `refs/heads/${input.branch}`]
      : ['push', '--', canonical, `${input.action.headSha}:refs/heads/${input.branch}`];
    return await execute([...settings, ...args], root, { ...environment, HELMSMAN_PUBLICATION_REPO: input.repo, HELMSMAN_PUBLICATION_TOKEN: input.token });
  } finally { await rm(root, { recursive: true, force: true }); }
}

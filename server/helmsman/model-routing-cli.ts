import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Transport = 'openai-responses' | 'anthropic-messages';
interface Input { readonly version: 1; readonly command: { readonly cmd: string; readonly args: readonly string[] }; readonly transport: Transport;
  readonly modelGateway: { readonly url: string; readonly token: string }; readonly skillsPath: string | null; }

function input(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model routing input is invalid');
  const item = value as Record<string, unknown>;
  const command = item.command;
  const gateway = item.modelGateway;
  if (item.version !== 1 || !command || typeof command !== 'object' || Array.isArray(command) || !gateway || typeof gateway !== 'object' || Array.isArray(gateway)) throw new Error('Model routing input is invalid');
  const valueCommand = command as Record<string, unknown>;
  const valueGateway = gateway as Record<string, unknown>;
  if (typeof valueCommand.cmd !== 'string' || !valueCommand.cmd || !Array.isArray(valueCommand.args) || valueCommand.args.some(value => typeof value !== 'string')
    || (item.transport !== 'openai-responses' && item.transport !== 'anthropic-messages') || typeof valueGateway.url !== 'string' || typeof valueGateway.token !== 'string'
    || item.skillsPath !== null && typeof item.skillsPath !== 'string') throw new Error('Model routing input is invalid');
  const url = new URL(valueGateway.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Model gateway is invalid');
  if (!/^[a-f\d]{64}$/i.test(valueGateway.token)) throw new Error('Model gateway capability is invalid');
  return { version: 1, command: { cmd: valueCommand.cmd, args: [...valueCommand.args] as string[] }, transport: item.transport,
    modelGateway: { url: url.href, token: valueGateway.token }, skillsPath: item.skillsPath as string | null };
}

function endpoint(url: string, path: string): string { return new URL(path, url).href.replace(/\/$/, ''); }

function cleanedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'GOCAAS_API_KEY', 'GOCAAS_API_KEY_HELPER', 'SLACK_MCP_TOKEN', 'SLACK_OAUTH_CLIENT_SECRET', 'SLACK_OAUTH_TOKEN_FILE', 'SLACK_OI_TOKEN', 'SLACK_OI_TOKEN_FILE', 'SLACK_OI_OAUTH_SESSION_ID',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_VERSION',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'VERTEXAI_PROJECT', 'VERTEXAI_LOCATION', 'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) delete environment[key];
  return environment;
}

async function linkSkills(home: string, skillsPath: string | null): Promise<void> {
  if (!skillsPath) return;
  const source = resolve(skillsPath, 'skills');
  const metadata = await lstat(source).catch(() => null);
  if (!metadata?.isDirectory()) return;
  await symlink(source, join(home, 'skills'), 'dir');
}

async function codexEnvironment(environment: NodeJS.ProcessEnv, url: string, token: string, skillsPath: string | null): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), 'helmsman-codex-home-'));
  const baseUrl = endpoint(url, 'openai/v1');
  await writeFile(join(home, 'config.toml'), `model_provider = "helmsman"\n[model_providers.helmsman]\nname = "Helmsman"\nbase_url = ${JSON.stringify(baseUrl)}\nenv_key = "HELMSMAN_MODEL_CAPABILITY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  environment.CODEX_HOME = home;
  environment.HELMSMAN_MODEL_CAPABILITY = token;
  environment.OPENAI_BASE_URL = baseUrl;
  environment.OPENAI_API_KEY = token;
  await linkSkills(home, skillsPath);
  return async () => { await rm(home, { recursive: true, force: true }); };
}

export function codexCommand(command: Input['command'], url: string): Input['command'] {
  if (basename(command.cmd) !== 'codex') return command;
  const interactive = command.args[0] !== 'exec' && command.args.includes('app-server');
  if (command.args[0] !== 'exec' && !interactive) return command;
  if (!interactive && command.args.length < 2) throw new Error('Codex routing requires an exec prompt');
  for (let index = 0; index < command.args.length; index += 1) {
    const argument = command.args[index] ?? '';
    const setting = argument === '-c' ? command.args[index + 1] ?? '' : argument.startsWith('--config=') ? argument.slice('--config='.length) : '';
    if (argument === '--oss' || argument.startsWith('--oss=') || argument === '--profile' || argument.startsWith('--profile=') || argument === '--ignore-user-config' || argument === '--config' || argument === '--config-file'
      || /^(?:model_provider|model_providers\.)\b/.test(setting.trim())) throw new Error('Codex routing options cannot be overridden');
  }
  const baseUrl = endpoint(url, 'openai/v1');
  const settings = [
    'model_provider="helmsman"',
    'model_providers.helmsman.name="Helmsman"',
    `model_providers.helmsman.base_url=${JSON.stringify(baseUrl)}`,
    'model_providers.helmsman.env_key="HELMSMAN_MODEL_CAPABILITY"',
    'model_providers.helmsman.wire_api="responses"',
    'model_providers.helmsman.requires_openai_auth=false',
  ];
  const insert = interactive ? command.args.indexOf('app-server') : command.args.length - 1;
  return { cmd: command.cmd, args: [...command.args.slice(0, insert), ...settings.flatMap(setting => ['-c', setting]), ...command.args.slice(insert)] };
}

export function claudeCommand(command: Input['command'], settingsPath: string): Input['command'] {
  if (basename(command.cmd) !== 'claude') return command;
  for (const argument of command.args) {
    if (argument === '--settings' || argument.startsWith('--settings=') || argument === '--setting-sources' || argument.startsWith('--setting-sources=')) {
      throw new Error('Claude routing settings cannot be overridden');
    }
  }
  return { cmd: command.cmd, args: [...command.args, '--settings', settingsPath, '--setting-sources', 'project,local'] };
}

export async function prepareModelRouting(value: unknown): Promise<{ command: Input['command']; environment: NodeJS.ProcessEnv; cleanup(): Promise<void> }> {
  const routed = input(value);
  const token = routed.modelGateway.token;
  const environment = cleanedEnvironment();
  let cleanup: () => Promise<void> = async () => undefined;
  let command = routed.command;
  if (routed.transport === 'openai-responses') cleanup = await codexEnvironment(environment, routed.modelGateway.url, token, routed.skillsPath);
  else {
    environment.ANTHROPIC_BASE_URL = endpoint(routed.modelGateway.url, 'anthropic');
    environment.ANTHROPIC_API_KEY = token;
    environment.ANTHROPIC_AUTH_TOKEN = token;
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    environment.CLAUDE_CODE_USE_FOUNDRY = '0';
    const home = await mkdtemp(join(tmpdir(), 'helmsman-claude-home-'));
    environment.CLAUDE_CONFIG_DIR = home;
    await linkSkills(home, routed.skillsPath);
    const settingsPath = join(home, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    } }), { mode: 0o600 });
    command = claudeCommand(command, settingsPath);
    cleanup = async () => { await rm(home, { recursive: true, force: true }); };
  }
  try {
    command = routed.transport === 'openai-responses' ? codexCommand(command, routed.modelGateway.url) : command;
    return { command, environment, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function runModelRoutingCli(raw = process.argv.slice(2).map(argument => argument.startsWith('--input=') ? argument.slice('--input='.length) : argument).join('')): Promise<number> {
  const { command, environment, cleanup } = await prepareModelRouting(JSON.parse(raw || 'null'));
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command.cmd, command.args, { env: environment, stdio: 'inherit' });
      const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch {} };
      const terminate = () => forward('SIGTERM');
      const interrupt = () => forward('SIGINT');
      const detach = () => {
        process.removeListener('SIGTERM', terminate);
        process.removeListener('SIGINT', interrupt);
      };
      const diagnostic = (text: string) => { try { process.stderr.write(`model-routing: ${basename(command.cmd)} ${text}\n`); } catch {} };
      process.once('SIGTERM', terminate);
      process.once('SIGINT', interrupt);
      child.once('error', (error: NodeJS.ErrnoException) => {
        detach();
        diagnostic(`could not start (${error.code ?? 'unknown error'})`);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        detach();
        if (signal) diagnostic(`terminated by signal ${signal}`);
        else if (code !== 0) diagnostic(`exited with code ${code ?? 1}`);
        resolve(signal ? 1 : code ?? 1);
      });
    });
  } finally { await cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runModelRoutingCli().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

import { rmSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

type Transport = 'openai-responses' | 'anthropic-messages';
interface Input { readonly version: 1; readonly command: { readonly cmd: string; readonly args: readonly string[] }; readonly transport: Transport;
  readonly modelGateway: { readonly url: string; readonly credentialPath: string }; }

function input(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model routing input is invalid');
  const item = value as Record<string, unknown>;
  const command = item.command;
  const gateway = item.modelGateway;
  if (item.version !== 1 || !command || typeof command !== 'object' || Array.isArray(command) || !gateway || typeof gateway !== 'object' || Array.isArray(gateway)) throw new Error('Model routing input is invalid');
  const valueCommand = command as Record<string, unknown>;
  const valueGateway = gateway as Record<string, unknown>;
  if (typeof valueCommand.cmd !== 'string' || !valueCommand.cmd || !Array.isArray(valueCommand.args) || valueCommand.args.some(value => typeof value !== 'string')
    || (item.transport !== 'openai-responses' && item.transport !== 'anthropic-messages') || typeof valueGateway.url !== 'string' || typeof valueGateway.credentialPath !== 'string') throw new Error('Model routing input is invalid');
  const url = new URL(valueGateway.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Model gateway is invalid');
  return { version: 1, command: { cmd: valueCommand.cmd, args: [...valueCommand.args] as string[] }, transport: item.transport,
    modelGateway: { url: url.href, credentialPath: valueGateway.credentialPath } };
}

function capability(path: string): string {
  const root = resolve(tmpdir());
  const directory = resolve(dirname(path));
  if (basename(path) !== 'capability' || !directory.startsWith(`${root}/helmsman-model-routing-`)) throw new Error('Model gateway capability path is invalid');
  let value = '';
  try { value = readFileSync(path, 'utf8').trim(); }
  finally { rmSync(path, { force: true }); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('Model gateway capability is invalid');
  return value;
}

function endpoint(url: string, path: string): string { return new URL(path, url).href.replace(/\/$/, ''); }

function cleanedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'GOCAAS_API_KEY', 'GOCAAS_API_KEY_HELPER',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_VERSION',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'VERTEXAI_PROJECT', 'VERTEXAI_LOCATION', 'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT', 'CODEX_HOME']) delete environment[key];
  return environment;
}

async function codexEnvironment(environment: NodeJS.ProcessEnv, url: string, token: string): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), 'helmsman-codex-home-'));
  const baseUrl = endpoint(url, 'openai/v1');
  await writeFile(join(home, 'config.toml'), `model_provider = "helmsman"\n[model_providers.helmsman]\nname = "Helmsman"\nbase_url = ${JSON.stringify(baseUrl)}\nenv_key = "HELMSMAN_MODEL_CAPABILITY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  environment.CODEX_HOME = home;
  environment.HELMSMAN_MODEL_CAPABILITY = token;
  environment.OPENAI_BASE_URL = baseUrl;
  return async () => { await rm(home, { recursive: true, force: true }); };
}

export function codexCommand(command: Input['command'], url: string): Input['command'] {
  if (basename(command.cmd) !== 'codex' || command.args[0] !== 'exec') return command;
  const baseUrl = endpoint(url, 'openai/v1');
  const settings = [
    'model_provider="helmsman"',
    'model_providers.helmsman.name="Helmsman"',
    `model_providers.helmsman.base_url=${JSON.stringify(baseUrl)}`,
    'model_providers.helmsman.env_key="HELMSMAN_MODEL_CAPABILITY"',
    'model_providers.helmsman.wire_api="responses"',
    'model_providers.helmsman.requires_openai_auth=false',
  ];
  return { cmd: command.cmd, args: ['exec', ...settings.flatMap(setting => ['-c', setting]), ...command.args.slice(1)] };
}

export async function runModelRoutingCli(raw = process.argv[2]): Promise<number> {
  const routed = input(JSON.parse(raw ?? 'null'));
  const token = capability(routed.modelGateway.credentialPath);
  const environment = cleanedEnvironment();
  let cleanup: () => Promise<void> = async () => undefined;
  if (routed.transport === 'openai-responses') cleanup = await codexEnvironment(environment, routed.modelGateway.url, token);
  else {
    environment.ANTHROPIC_BASE_URL = endpoint(routed.modelGateway.url, 'anthropic');
    environment.ANTHROPIC_API_KEY = token;
    environment.ANTHROPIC_AUTH_TOKEN = token;
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  try {
    const command = routed.transport === 'openai-responses' ? codexCommand(routed.command, routed.modelGateway.url) : routed.command;
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command.cmd, command.args, { env: environment, stdio: 'inherit' });
      const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch {} };
      process.once('SIGTERM', () => forward('SIGTERM'));
      process.once('SIGINT', () => forward('SIGINT'));
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
  } finally { await cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runModelRoutingCli().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

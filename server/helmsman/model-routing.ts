import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeNodeArguments, isHostCoordinatorCommand } from './runtime-paths';
import type { AgentAdapter, AgentTask } from './agents/adapter';

type Transport = 'openai-responses' | 'anthropic-messages';
type ModelGateway = { readonly url: string; readonly token: string };
type RoutedTask = AgentTask & { readonly modelGateway?: ModelGateway };

function gateway(task: AgentTask): ModelGateway | undefined {
  const value = (task as RoutedTask).modelGateway;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || typeof value.token !== 'string') throw new Error('Model gateway is invalid');
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !/^[a-f\d]{64}$/i.test(value.token)) throw new Error('Model gateway must be this run’s local scoped gateway');
  return { url: url.href, token: value.token };
}

function transport(adapter: AgentAdapter): Transport | null {
  const declared = adapter.metadata?.docker;
  if (declared === 'openai-responses' || declared === 'anthropic-messages') return declared;
  if (adapter.id === 'codex') return 'openai-responses';
  if (adapter.id === 'claude-code') return 'anthropic-messages';
  return null;
}

function credentialFile(token: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-model-routing-'));
  const path = join(directory, 'capability');
  writeFileSync(path, token, { mode: 0o600, flag: 'wx' });
  return path;
}

export function buildRoutedAgentCommand(adapter: AgentAdapter, task: AgentTask): { cmd: string; args: string[] } {
  const command = adapter.buildCommand(task);
  const modelGateway = gateway(task);
  if (!modelGateway || isHostCoordinatorCommand(command)) return command;
  const route = transport(adapter);
  if (!route) throw new Error(`Agent provider ${adapter.id} does not declare a supported model transport for scoped routing`);
  const credentialPath = credentialFile(modelGateway.token);
  return {
    cmd: process.execPath,
    args: [...runtimeNodeArguments('./model-routing-cli.ts', import.meta.url), JSON.stringify({ version: 1, command, transport: route,
      modelGateway: { url: modelGateway.url, credentialPath } })],
  };
}

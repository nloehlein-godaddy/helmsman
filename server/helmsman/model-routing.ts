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

export function buildRoutedAgentCommand(adapter: AgentAdapter, task: AgentTask): { cmd: string; args: string[] } {
  const command = adapter.buildCommand(task);
  const modelGateway = gateway(task);
  if (!modelGateway || isHostCoordinatorCommand(command)) return command;
  const route = transport(adapter);
  if (!route) throw new Error(`Agent provider ${adapter.id} does not declare a supported model transport for scoped routing`);
  // Long individual script arguments can be killed before Node starts on macOS.
  // Prefixes keep retained hosts from remapping payload fragments as runtime paths.
  const chunks: string[] = [];
  let chunk = '--input=';
  for (const character of JSON.stringify({ version: 1, command, transport: route, modelGateway, skillsPath: task.skillsPath ?? null })) {
    if (chunk.length + character.length > 256) {
      chunks.push(chunk);
      chunk = '--input=';
    }
    chunk += character;
  }
  chunks.push(chunk);
  return {
    cmd: process.execPath,
    args: [...runtimeNodeArguments('./model-routing-cli.ts', import.meta.url), ...chunks],
  };
}

import { runtimeNodeArguments, isHostCoordinatorCommand, chunkInputArguments } from './runtime-paths';
import { interactiveAgentCommand } from './interactive-agent';
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
  const modelGateway = gateway(task);
  if (task.instructions && !task.dockerExecution && !task.hostIsolation && adapter.buildInteractiveCommand) {
    const interactive = adapter.buildInteractiveCommand(task);
    return interactiveAgentCommand(task, adapter.id, interactive, transport(adapter));
  }
  const command = adapter.buildCommand(task);
  if (!modelGateway || isHostCoordinatorCommand(command)) return command;
  const route = transport(adapter);
  if (!route) throw new Error(`Agent provider ${adapter.id} does not declare a supported model transport for scoped routing`);
  const chunks = chunkInputArguments(JSON.stringify({ version: 1, command, transport: route, modelGateway, skillsPath: task.skillsPath ?? null }));
  return {
    cmd: process.execPath,
    args: [...runtimeNodeArguments('./model-routing-cli.ts', import.meta.url), ...chunks],
  };
}

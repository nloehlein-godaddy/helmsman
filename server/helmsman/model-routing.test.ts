import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildRoutedAgentCommand } from './model-routing';
import { claudeCommand, codexCommand } from './model-routing-cli';
import type { AgentAdapter, AgentTask } from './agents/adapter';

const token = 'a'.repeat(64);
const gateway = { url: 'http://127.0.0.1:8790/', token };
const task = { ticketId: 'TASK-1', title: 'Task', repo: 'owner/repo', jiraBaseUrl: '', modelGateway: gateway } as AgentTask & { modelGateway: typeof gateway };
const capture = `const fs=require('node:fs'); fs.writeFileSync(process.env.ROUTING_OUTPUT, JSON.stringify({argv:process.argv.slice(2), env:{OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_BASE_URL:process.env.OPENAI_BASE_URL,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL,CLAUDE_CODE_OAUTH_TOKEN:process.env.CLAUDE_CODE_OAUTH_TOKEN,SLACK_OI_TOKEN:process.env.SLACK_OI_TOKEN,SLACK_OI_TOKEN_FILE:process.env.SLACK_OI_TOKEN_FILE,SLACK_OI_OAUTH_SESSION_ID:process.env.SLACK_OI_OAUTH_SESSION_ID,SLACK_MCP_TOKEN:process.env.SLACK_MCP_TOKEN,GOCAAS_API_KEY:process.env.GOCAAS_API_KEY,GOCAAS_API_KEY_HELPER:process.env.GOCAAS_API_KEY_HELPER,CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,capability:process.env.HELMSMAN_MODEL_CAPABILITY,disable:process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,skills:fs.existsSync((process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR)+'/skills/review-agent/SKILL.md'),config:process.env.CODEX_HOME?fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'):null,claudeSettings:process.env.CLAUDE_CONFIG_DIR?fs.readFileSync(process.env.CLAUDE_CONFIG_DIR+'/settings.json','utf8'):null}}));`;

function adapter(id: string, transport: NonNullable<AgentAdapter['metadata']>['docker']): AgentAdapter {
  return { id, metadata: { version: 1, label: id, defaults: { model: null, effort: null }, review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } }, reviewSkills: [], reviewDelegation: 'none', supportsPrePr: true, docker: transport, costReporting: 'delta' },
    buildCommand: () => ({ cmd: process.execPath, args: ['-e', capture] }), parseLine: () => null };
}

function run(value: AgentAdapter, pinnedSkills = false) {
  const root = mkdtempSync(join(tmpdir(), 'model-routing-test-'));
  const output = join(root, 'output.json');
  try {
    if (pinnedSkills) {
      mkdirSync(join(root, 'skills/review-agent'), { recursive: true });
      writeFileSync(join(root, 'skills/review-agent/SKILL.md'), 'Pinned fixture review instructions.');
    }
    const selectedTask = { ...task, ...(pinnedSkills ? { skillsPath: root } : {}) };
    const command = buildRoutedAgentCommand(value, selectedTask);
    expect(buildRoutedAgentCommand(value, selectedTask)).toEqual(command);
    expect(JSON.stringify(command.args)).toContain(token);
    const result = spawnSync(command.cmd, command.args, { encoding: 'utf8', env: { ...process.env, ROUTING_OUTPUT: output,
      OPENAI_API_KEY: 'direct-openai', ANTHROPIC_API_KEY: 'direct-anthropic', CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      SLACK_OI_TOKEN: 'oi-host-only', SLACK_OI_TOKEN_FILE: '/private/oi-token', SLACK_OI_OAUTH_SESSION_ID: 'oi-private-session', SLACK_MCP_TOKEN: 'slack-host-only', GOCAAS_API_KEY: 'upstream-key', GOCAAS_API_KEY_HELPER: 'helper-key' } });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(output, 'utf8')) as { argv: string[]; env: Record<string, string | undefined> };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('model routing', () => {
  it('routes Codex through the scoped OpenAI endpoint without exposing a direct credential', () => {
    const result = run(adapter('codex', 'openai-responses'));
    expect(result.env.OPENAI_API_KEY).toBe(token);
    expect(result.env.GOCAAS_API_KEY).toBeUndefined();
    expect(result.env.SLACK_MCP_TOKEN).toBeUndefined();
    expect(result.env.SLACK_OI_TOKEN).toBeUndefined();
    expect(result.env.SLACK_OI_TOKEN_FILE).toBeUndefined();
    expect(result.env.SLACK_OI_OAUTH_SESSION_ID).toBeUndefined();
    expect(result.env.GOCAAS_API_KEY_HELPER).toBeUndefined();
    expect(result.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:8790/openai/v1');
    expect(result.env.capability).toBe(token);
    expect(result.env.config).toContain('model_provider = "helmsman"');
    expect(result.env.config).toContain('base_url = "http://127.0.0.1:8790/openai/v1"');
  });

  it('routes Claude through the scoped Anthropic endpoint and removes OAuth', () => {
    const result = run(adapter('claude-code', 'anthropic-messages'));
    expect(result.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8790/anthropic');
    expect(result.env.ANTHROPIC_API_KEY).toBe(token);
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.env.disable).toBe('1');
    expect(result.env.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(result.env.claudeSettings).toContain('CLAUDE_CODE_USE_FOUNDRY');
  });

  it.each(['openai-responses', 'anthropic-messages'] as const)('keeps pinned review skills available and removes temporary %s configuration after exit', transport => {
    const result = run(adapter('fixture/agent', transport), true);
    expect(result.env.skills).toBe(true);
    const home = result.env.CODEX_HOME ?? result.env.CLAUDE_CONFIG_DIR;
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  });

  it('rejects custom providers without a declared transport', () => {
    expect(() => buildRoutedAgentCommand(adapter('custom/provider', null), task)).toThrow('does not declare');
  });

  it('does not wrap retained coordinator commands', () => {
    const coordinator: AgentAdapter = { ...adapter('codex', 'openai-responses'),
      buildCommand: () => ({ cmd: process.execPath, args: ['/runtime/pre-pr-cli.ts', '{}'] }) };
    expect(buildRoutedAgentCommand(coordinator, task)).toEqual({ cmd: process.execPath, args: ['/runtime/pre-pr-cli.ts', '{}'] });
  });

  it('places Codex routing configuration in exec option position before the prompt', () => {
    const command = codexCommand({ cmd: 'codex', args: ['exec', '--json', 'prompt'] }, gateway.url);
    expect(command.args).toEqual(expect.arrayContaining(['exec', '-c', 'model_provider="helmsman"']));
    expect(command.args.indexOf('model_provider="helmsman"')).toBeLessThan(command.args.indexOf('prompt'));
  });

  it('rejects incoming Codex routing overrides', () => {
    expect(() => codexCommand({ cmd: 'codex', args: ['exec', '-c', 'model_provider="other"', 'prompt'] }, gateway.url)).toThrow('cannot be overridden');
    expect(() => codexCommand({ cmd: 'codex', args: ['exec', '--oss', 'prompt'] }, gateway.url)).toThrow('cannot be overridden');
    expect(() => codexCommand({ cmd: 'codex', args: ['exec', '--ignore-user-config', 'prompt'] }, gateway.url)).toThrow('cannot be overridden');
  });

  it('uses its generated Claude settings ahead of user settings', () => {
    expect(claudeCommand({ cmd: 'claude', args: ['-p', 'prompt'] }, '/private/settings.json').args).toEqual(['-p', 'prompt', '--settings', '/private/settings.json', '--setting-sources', 'project,local']);
    expect(() => claudeCommand({ cmd: 'claude', args: ['--settings', 'user.json'] }, '/private/settings.json')).toThrow('cannot be overridden');
  });
});

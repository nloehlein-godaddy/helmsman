import { parsePluginPackage } from '../../../src/plugins/package';
import codex from '../../../src/plugins/agent-codex/backend';
import claude from '../../../src/plugins/agent-claude/backend';
import command from '../../../src/plugins/agent-command/backend';
import type { BuiltinBackendPlugin } from './backend';

export const builtinAgents: readonly BuiltinBackendPlugin[] = [
  { package: parsePluginPackage({ packageVersion: 1, manifest: { manifestVersion: 1, id: 'helmsman.agent-codex', version: '0.1.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'codex' }], agents: { codex: { access: ['process-description'] } }, settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: codex },
  { package: parsePluginPackage({ packageVersion: 1, manifest: { manifestVersion: 1, id: 'helmsman.agent-claude', version: '0.1.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'claude-code' }], agents: { 'claude-code': { access: ['process-description'] } }, settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: claude },
  { package: parsePluginPackage({ packageVersion: 1, manifest: { manifestVersion: 1, id: 'helmsman.agent-command', version: '0.1.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'command' }], agents: { command: { access: ['process-description'] } }, settings: { commandTemplate: { type: 'string', default: '', maxLength: 4096 } }, storageVersion: 1 } }, { allowBuiltin: true }), module: command },
];

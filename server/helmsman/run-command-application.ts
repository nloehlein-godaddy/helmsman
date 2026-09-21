import { isContributionId } from '../../src/plugins/manifest';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { validEffort, validModel } from '../../src/logic/agentOptions';
import type { RunCommandV1 } from '../../src/plugins/run-command';
import type { Db } from './db';
import type { AdmissionStore } from './admission-store';
import type { ExecutionStore } from './execution-store';
import type { ExecutionControls } from './execution-controls';
import { retryIntent, RetryError, type LaunchIntent } from './retry';
import type { TodoApi } from './task-source-todos';
import { createRunCommandCoordinator, RunCommandError, RunCommandRejection, type TargetRunCommand } from './run-command-coordinator';
import type { RunCommandStore, StoredRunCommand } from './run-command-store';
import { persistenceHash, PersistenceConflictError } from './persistence';
import { TodoConflictError, TodoValidationError } from './todos';

export interface RunCommandAdmissionBinding { readonly caller: string; readonly requestId: string; readonly contentHash: string; }
export function runCommandAdmissionBinding(record: StoredRunCommand): RunCommandAdmissionBinding {
  return { caller: record.caller, requestId: record.command.requestId, contentHash: record.contentHash };
}
export function runCommandContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry =>
      entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/run-command' && requirement.version === 1) === true;
}

export function createApplicationRunCommands(options: {
  store: RunCommandStore; db: Db; admissions: AdmissionStore; executions: ExecutionStore; controls: ExecutionControls;
  catalog(): PluginCatalog; repos(): readonly string[]; todos: TodoApi; jiraEnabled(): boolean;
  canStart(repo: string): { ok: boolean; reason?: string };
  launch(input: LaunchIntent & { runId: string; retryOf?: string; headSha?: string; commandBinding: RunCommandAdmissionBinding }): string;
  stop(runId: string): boolean;
}) {
  const { db, admissions, executions, controls } = options;
  function target(command: TargetRunCommand): void {
    const run = db.getRun(command.target.runId);
    const admission = run ? null : admissions.get(command.target.runId);
    if (run ? run.repo !== command.repo || run.attempt !== command.target.expectedAttempt
      : !admission || admission.repo !== command.repo || command.target.expectedAttempt !== 1 || !['pending', 'blocked'].includes(admission.state)) {
      throw new RunCommandRejection('The voyage or its attempt changed. Refresh before trying again.');
    }
    if (command.action === 'retry' ? run?.status !== 'failed' : run && run.status !== 'running') {
      throw new RunCommandRejection(command.action === 'retry' ? 'Only failed voyages can be retried.' : 'This voyage is no longer running.');
    }
  }
  function gates(intent: LaunchIntent): void {
    if (!options.repos().includes(intent.repo)) throw new RunCommandRejection('This galleon is no longer configured.');
    const gate = options.canStart(intent.repo);
    if (!gate.ok) throw new RunCommandRejection(gate.reason ?? 'Cannot start another voyage.');
    if (intent.mode === 'ticket' && !options.jiraEnabled()) throw new RunCommandRejection('Enable Jira before retrying a Jira voyage.');
  }
  function intent(command: RunCommandV1): LaunchIntent & { retryOf?: string; headSha?: string } {
    if (command.action === 'stop') throw new RunCommandRejection('Stop cannot launch a voyage.');
    if (command.action === 'retry') {
      const run = db.getRun(command.target.runId);
      if (!run) throw new RunCommandRejection('Voyage is unavailable.');
      try { return { ...retryIntent(run), retryOf: run.id }; }
      catch (error) { if (error instanceof RetryError) throw new RunCommandRejection(error.message); throw error; }
    }
    if (command.action !== 'launch') throw new RunCommandRejection('Invalid launch action.');
    const launch = command.launch;
    if (launch.model !== undefined && validModel(launch.model) !== launch.model
      || launch.effort !== undefined && validEffort(launch.effort) !== launch.effort) throw new RunCommandRejection('Invalid agent model or effort.');
    return { repo: command.repo, ...launch };
  }
  return createRunCommandCoordinator({
    store: options.store,
    authorizeRead(caller) { if (!isContributionId(caller)) throw new RunCommandError(403, 'Invalid command contribution.'); },
    authorizeWrite(caller) { if (!runCommandContributionEnabled(options.catalog(), caller)) throw new RunCommandRejection('This command contribution is unavailable.'); },
    validateTarget: target,
    async prepareLaunch(command) {
      const prepared = intent(command); gates(prepared);
      if (prepared.mode === 'todo') {
        const todo = prepared.todoId ? await options.todos.get(prepared.todoId) : null;
        if (!todo || todo.repo !== prepared.repo || todo.runId !== prepared.retryOf || !['todo', 'blocked'].includes(todo.state) || !todo.description.trim()) {
          throw new RunCommandRejection('The todo must still belong to this failed voyage, have a description, and be To do or Blocked.');
        }
      }
      return prepared;
    },
    launch(prepared, record) {
      gates(prepared);
      if (persistenceHash(intent(record.command)) !== persistenceHash(prepared)) throw new RunCommandRejection('The original voyage requirements changed.');
      try {
        return { runId: options.launch({ ...prepared, runId: record.assignedRunId, commandBinding: runCommandAdmissionBinding(record) }), attempt: 1 };
      } catch (error) {
        if (error instanceof RetryError || error instanceof TodoConflictError || error instanceof TodoValidationError || error instanceof PersistenceConflictError) {
          throw new RunCommandRejection(error.message);
        }
        throw error;
      }
    },
    recordStop(command) { controls.requestStop({ runId: command.target.runId, attempt: command.target.expectedAttempt }); },
    signalStop(command) {
      const current = db.getRun(command.target.runId);
      if (!current && command.target.expectedAttempt === 1 || current?.attempt === command.target.expectedAttempt && current.status === 'running') options.stop(command.target.runId);
    },
    inspect(record) {
      const command = record.command;
      if (command.action === 'stop') {
        const repo = db.getRun(command.target.runId)?.repo ?? admissions.get(command.target.runId)?.repo;
        return repo === command.repo && controls.isStopRequested({ runId: command.target.runId, attempt: command.target.expectedAttempt })
          ? { status: 'accepted', runId: command.target.runId, attempt: command.target.expectedAttempt, message: null } : { status: 'absent' };
      }
      const admission = admissions.get(record.assignedRunId);
      if (admission) {
        const request = admission.request as { commandBinding?: unknown } | null;
        if (admission.repo === command.repo && request?.commandBinding && persistenceHash(request.commandBinding) === persistenceHash(runCommandAdmissionBinding(record))) {
          return { status: 'accepted', runId: record.assignedRunId, attempt: 1, message: null };
        }
        return { status: 'recovery-required', runId: record.assignedRunId, attempt: 1, message: 'Retained admission does not match this command.' };
      }
      if (db.getRun(record.assignedRunId) || executions.attempt({ runId: record.assignedRunId, attempt: 1 })
        || executions.reservations().some(reservation => reservation.runId === record.assignedRunId)) {
        return { status: 'recovery-required', runId: record.assignedRunId, attempt: 1, message: 'Execution evidence requires reconciliation.' };
      }
      return { status: 'absent' };
    },
  });
}

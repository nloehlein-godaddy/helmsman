import { COMMUNICATION_TIMEOUT_MS } from './communication-timeout';
import { isContributionId } from "../../src/plugins/manifest";
import { builtinFrontendManifests } from "../../src/plugins/frontend-manifests";
import type { PluginCatalog } from "../../src/plugins/runtime";
import {
  parseCommunicationCommandV1,
  parseCommunicationCommandReceiptQueryV1,
  parseCommunicationCommandReceiptV1,
  type CommunicationCommandInputV1,
  type CommunicationCommandReceiptQueryV1,
  type CommunicationCommandReceiptV1,
  type CommunicationCommandV1,
  type CommunicationDestinationV1,
} from "../../src/plugins/communication-command";
import type { ArtifactBinding, ProviderBinding } from "./execution-store";
import {
  clarificationScope,
  ClarificationServiceError,
} from "./clarification-service-common";
import {
  dispatchOperation,
  type OperationResolver,
  type OperationAdapter,
} from "./operation-dispatcher";
import type { DurableOperation, OperationStore } from "./operations";
import {
  persistedJson,
  persistenceHash,
  PersistenceConflictError,
  PersistenceValidationError,
  stableJson,
  type Persistence,
} from "./persistence";
export interface CommunicationCommandPreparation {
  assertCurrent?(): void;
  readonly binding: ProviderBinding;
  readonly artifacts: readonly ArtifactBinding[];
  readonly target: {
    readonly repo: string;
    readonly number: number;
    readonly destination: CommunicationDestinationV1;
  };
}
export interface CommunicationCommandServerOptions {
  readonly persistence: Persistence;
  readonly operations: OperationStore;
  repos(): readonly string[];
  authorize(caller: string): void;
  assertAdmission(): void;
  assertReviewable?(repo: string, number: number): Promise<void>;
  prepareReviewRequest(
    input: CommunicationCommandInputV1,
    signal?: AbortSignal,
  ): Promise<CommunicationCommandPreparation>;
  readonly resolve: OperationResolver;
}
export interface CommunicationCommandServerService {
  submit(
    caller: string,
    command: CommunicationCommandV1,
    scope: string | null,
  ): Promise<CommunicationCommandReceiptV1>;
  receipt(
    caller: string,
    query: CommunicationCommandReceiptQueryV1,
    scope: string | null,
  ): CommunicationCommandReceiptV1 | null;
  retry(
    caller: string,
    command: CommunicationCommandV1,
    scope: string | null,
  ): Promise<CommunicationCommandReceiptV1>;
  readonly resolve: OperationResolver;
  dispatch(id: string): Promise<DurableOperation>;
  drainPending(): Promise<void>;
}
const kind = "communication.review-request";
const origin = "public-communication-review-request";
const cooldownMs = 60_000;

export function communicationCommandContributionEnabled(
  catalog: PluginCatalog,
  caller: string,
): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split("/");
  const manifest =
    catalog.plugins.find((plugin) => plugin.package.manifest.id === pluginId)
      ?.package.manifest ??
    builtinFrontendManifests.find(
      (manifest) =>
        manifest.id === pluginId &&
        catalog.builtins?.some(
          (entry) =>
            entry.id === pluginId &&
            entry.enabled &&
            entry.version === manifest.version,
        ),
    );
  const contribution =
    manifest?.pages.find((page) => page.id === localId) ??
    (manifest?.manifestVersion === 2
      ? manifest.panels.find((panel) => panel.id === localId)
      : undefined);
  return (
    contribution?.requires?.some(
      (requirement) =>
        requirement.id === "helmsman/communication-command" &&
        requirement.version === 1,
    ) === true
  );
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const key = (caller: string, id: string) =>
  "public-communication:" + persistenceHash({ caller, requestId: id });
function record(operation: DurableOperation) {
  const payload = operation.payload as Record<string, unknown> | null,
    command = parseCommunicationCommandV1(payload?.command),
    target = operation.target as Record<string, unknown> | null,
    caller = payload?.caller;
  if (
    typeof caller !== "string" ||
    !isContributionId(caller) ||
    operation.kind !== kind ||
    operation.origin.kind !== origin ||
    operation.key !== key(caller, command.requestId) ||
    operation.origin.id !== command.requestId ||
    operation.origin.revision !== persistenceHash({ caller, command }) ||
    target?.repo !== command.repo ||
    target?.number !== command.number ||
    !same(target?.destination, command.expectedDestination) ||
    payload?.manual !== true ||
    !same(payload?.expectedDestination, command.expectedDestination)
  )
    throw new PersistenceValidationError(
      "Communication operation integrity failed",
    );
  return { caller, command };
}
function project(operation: DurableOperation): CommunicationCommandReceiptV1 {
  const { command } = record(operation);
  const { requestId, ...input } = command;
  const base = { version: 1 as const, requestId, input, result: null };
  if (operation.status === "completed") {
    try {
      const r = operation.receipt as Record<string, unknown> | null;
      return parseCommunicationCommandReceiptV1(
        {
          ...base,
          status: "succeeded",
          result: (() => {
            const destination = command.expectedDestination;
            if (
              r?.workspace !== destination.workspace ||
              r?.channel !== destination.channel ||
              r?.mention !== destination.mention ||
              r?.connectionId !== destination.connectionId
            ) {
              throw new Error(
                "Recorded communication receipt does not match its destination.",
              );
            }
            return {
              repo: command.repo,
              number: command.number,
              destination,
              permalink: r?.permalink,
            };
          })(),
          reason: null,
        },
        command,
      );
    } catch {
      return {
        ...base,
        status: "recovery-required",
        reason: "The recorded completion does not prove delivery.",
      };
    }
  }
  return operation.requiresReconciliation ||
    operation.status === "blocked" ||
    operation.status === "uncertain"
    ? {
        ...base,
        status: "recovery-required",
        reason:
          operation.diagnostic?.message?.slice(0, 2000) ??
          "Recovery is required.",
      }
    : { ...base, status: "pending", reason: null };
}
export function createCommunicationCommandService(
  options: CommunicationCommandServerOptions,
): CommunicationCommandServerService {
  const access = (caller: string, repo: string, scope: string | null) => {
    if (!isContributionId(caller))
      throw new ClarificationServiceError(403, "forbidden");
    options.authorize(caller);
    clarificationScope(options.repos(), scope, repo);
  };
  const recent = (caller: string, command: CommunicationCommandV1): void => {
    const now = Date.now();
    const matching = options.operations.list().some((operation) => {
      if (operation.kind !== kind || operation.origin.kind !== origin)
        return false;
      try {
        const saved = record(operation);
        if (
          saved.caller === caller &&
          saved.command.requestId === command.requestId
        )
          return false;
        return (
          saved.command.repo === command.repo &&
          saved.command.number === command.number &&
          same(
            saved.command.expectedDestination,
            command.expectedDestination,
          ) &&
          Date.parse(operation.createdAt) > now - cooldownMs
        );
      } catch {
        return false;
      }
    });
    if (matching)
      throw new PersistenceConflictError(
        "A communication request was just attempted for this pull request.",
      );
  };
  const find = (caller: string, q: CommunicationCommandReceiptQueryV1) => {
    const operation = options.operations.byKey(key(caller, q.requestId));
    if (operation) {
      const saved = record(operation);
      if (saved.caller !== caller || saved.command.repo !== q.repo)
        throw new ClarificationServiceError(404, "not-found");
    }
    return operation;
  };
  const resolve: OperationResolver = async (operation, signal) => {
    if (operation.origin.kind !== origin) return null;
    record(operation);
    const adapter = await options.resolve(operation, signal);
    if (!adapter) return null;
    const manual = async (method: 'invoke' | 'reconcile', ...args: Parameters<OperationAdapter['invoke']>) => {
      const result = await adapter[method](...args);
      return result.status === 'definitely-not-applied' ? { ...result, retryable: false } : result;
    };
    return Object.freeze<OperationAdapter>({ ...adapter,
      invoke: (live, context) => manual('invoke', live, context),
      reconcile: (live, context) => manual('reconcile', live, context),
    });
  };
  const dispatch = (id: string) =>
    dispatchOperation(options.operations, id, resolve, { reconcile: true, timeoutMs: COMMUNICATION_TIMEOUT_MS });
  return {
    resolve,
    dispatch,
    async submit(caller, raw, scope) {
      const command = parseCommunicationCommandV1(raw);
      access(caller, command.repo, scope);
      const exists = find(caller, command);
      if (exists) {
        if (!same(record(exists).command, command))
          throw new PersistenceConflictError(
            "Communication request content changed",
          );
        return project(await dispatch(exists.id));
      }
      options.assertAdmission();
      recent(caller, command);
      await options.assertReviewable?.(command.repo, command.number);
      const { requestId, ...input } = command,
        prepared = await options.prepareReviewRequest(input);
      if (
        prepared.target.repo !== command.repo ||
        prepared.target.number !== command.number ||
        !same(prepared.target.destination, command.expectedDestination)
      )
        throw new PersistenceValidationError(
          "Communication destination changed",
        );
      const operation = options.persistence.transaction(() => {
        access(caller, command.repo, scope);
        options.assertAdmission();
        prepared.assertCurrent?.();
        const prior = find(caller, command);
        if (prior) {
          if (!same(record(prior).command, command))
            throw new PersistenceConflictError(
              "Communication request content changed",
            );
          return prior;
        }
        recent(caller, command);
        return options.operations.enqueue({
          version: 1,
          key: key(caller, requestId),
          kind,
          origin: {
            kind: origin,
            id: requestId,
            revision: persistenceHash({ caller, command }),
            runId: null,
            attempt: null,
          },
          binding: prepared.binding,
          artifacts: prepared.artifacts,
          target: persistedJson(prepared.target),
          payload: persistedJson({
            caller,
            requestId,
            command,
            manual: true,
            expectedDestination: command.expectedDestination,
          }),
        });
      });
      return project(await dispatch(operation.id));
    },
    receipt(caller, q, scope) {
      const query = parseCommunicationCommandReceiptQueryV1(q);
      access(caller, query.repo, scope);
      const operation = find(caller, query);
      return operation ? project(operation) : null;
    },
    async retry(caller, raw, scope) {
      const query = parseCommunicationCommandV1(raw);
      access(caller, query.repo, scope);
      const operation = find(caller, query);
      if (!operation) throw new ClarificationServiceError(404, "not-found");
      if (!same(record(operation).command, query)) throw new PersistenceConflictError('Communication request content changed');
      if (operation.status === 'blocked' && !operation.requiresReconciliation && operation.diagnostic?.code === 'delivery-blocked') {
        options.operations.retry(operation.id, { actor: caller, reason: 'Explicit retry of original communication request', evidence: { requestId: query.requestId } });
      }
      return project(await dispatch(operation.id));
    },
    async drainPending() {
      for (const operation of options.operations.list({
        statuses: ["pending", "retrying", "leased", "blocked", "uncertain"],
      }))
        if (operation.origin.kind === origin) await dispatch(operation.id);
    },
  };
}

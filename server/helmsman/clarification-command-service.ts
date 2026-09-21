import { parseClarificationCommandV1, parseClarificationCommandReceiptQueryV1,
  type ClarificationCommandV1, type ClarificationCommandReceiptV1, type ClarificationCommandReceiptQueryV1 } from '../../src/plugins/clarification-command';
import { createClarificationAccess, type ClarificationServerOptions } from './clarification-read-service';
import type { ClarificationReceiptStore } from './clarification-receipt-store';
import { authorizeClarification, clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { PersistenceConflictError, stableJson } from './persistence';

export interface ClarificationCommandServerService {
  submit(caller: string, command: ClarificationCommandV1, scopeRepo: string | null): ClarificationCommandReceiptV1;
  receipt(caller: string, query: ClarificationCommandReceiptQueryV1, scopeRepo: string | null): ClarificationCommandReceiptV1 | null;
}
export function createClarificationCommandService(options: ClarificationServerOptions & { receipts: ClarificationReceiptStore }): ClarificationCommandServerService {
  const { persistence, receipts } = options; const { sql } = persistence; const access = createClarificationAccess(options);
  if (receipts.persistence.sql !== sql) throw new PersistenceConflictError('Clarification receipts must share the mutation database');
  return {
    submit(caller, raw, scopeRepo) {
      authorizeClarification(options, caller, 'clarification-command');
      const command = parseClarificationCommandV1(raw); clarificationScope(options.repos(), scopeRepo, command.repo);
      const { requestId, ...input } = command;
      return persistence.transaction(() => {
        const previous = receipts.answer(caller, requestId);
        if (previous) {
          if (stableJson(previous.input) !== stableJson(input)) throw new PersistenceConflictError('Clarification request content changed');
          return previous;
        }
        const reject = (reason: NonNullable<ClarificationCommandReceiptV1['reason']>) => receipts.saveAnswer(caller,
          { version: 1, requestId, input, status: 'rejected', result: null, reason });
        const row = access.question(input.questionId);
        if (!row || row.repo !== input.repo || row.runId !== input.runId) return reject('not-found');
        const observedAt = access.now(); const item = access.project(row, observedAt);
        if (item.provenance.kind === 'legacy-unproven') return reject('provenance-unknown');
        if (item.provenance.attempt !== input.expectedAttempt || item.currentAttempt !== null && item.currentAttempt !== input.expectedAttempt) return reject('different-attempt');
        if (item.provenance.channelId !== input.expectedChannelId) return reject('channel-unavailable');
        if (item.revision !== input.expectedQuestionRevision) return reject('revision-changed');
        if (!item.answerability.available) {
          const reason = item.answerability.reason;
          const state = reason === 'deadline-expired' ? 'timed-out' : reason === 'run-inactive' || reason === 'run-unavailable' ? 'cancelled' : null;
          if (state !== null) sql.prepare("UPDATE clarifications SET state=? WHERE id=? AND state='pending'").run(state, row.id);
          return reject(reason);
        }
        const changed = sql.prepare(`UPDATE clarifications SET state='answered',answer=?,answeredAt=? WHERE id=? AND runId=? AND repo=? AND state='pending'
          AND EXISTS (SELECT 1 FROM clarification_question_metadata WHERE questionId=clarifications.id AND revision=? AND attempt=? AND channelId=?)`)
          .run(input.answer, observedAt, input.questionId, input.runId, input.repo, input.expectedQuestionRevision, input.expectedAttempt, input.expectedChannelId);
        if (changed.changes !== 1) return reject('revision-changed');
        const revision = options.clarifications.protocol.provenance(input.questionId)?.revision;
        if (revision !== input.expectedQuestionRevision + 1) throw new PersistenceConflictError('Clarification answer revision changed unexpectedly');
        return receipts.saveAnswer(caller, { version: 1, requestId, input, status: 'succeeded', reason: null,
          result: { questionId: input.questionId, revision, answer: input.answer, answeredAt: observedAt } });
      });
    },
    receipt(caller, raw, scopeRepo) {
      authorizeClarification(options, caller, 'clarification-command');
      const query = parseClarificationCommandReceiptQueryV1(raw); clarificationScope(options.repos(), scopeRepo, query.repo);
      return persistence.transaction(() => {
        const receipt = receipts.answer(caller, query.requestId);
        if (receipt && receipt.input.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found');
        return receipt;
      });
    },
  };
}

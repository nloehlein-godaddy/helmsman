import { parseSuggestedContactAdminCommandV1, parseSuggestedContactAdminContactV1, parseSuggestedContactAdminListQueryV1,
  parseSuggestedContactAdminLoadQueryV1, parseSuggestedContactAdminReceiptQueryV1,
  type SuggestedContactAdminCommandV1, type SuggestedContactAdminContactV1, type SuggestedContactAdminListQueryV1,
  type SuggestedContactAdminLoadQueryV1, type SuggestedContactAdminPageV1, type SuggestedContactAdminReceiptQueryV1, type SuggestedContactAdminReceiptV1 } from '../../src/plugins/suggested-contact-admin';
import type { ClarificationReceiptStore } from './clarification-receipt-store';
import { authorizeClarification, clarificationClock, ClarificationServiceError, createClarificationCursors, type ClarificationAuthority } from './clarification-service-common';
import { PersistenceConflictError, stableJson, type Persistence } from './persistence';

export interface SuggestedContactAdminServerService {
  list(caller: string, query: SuggestedContactAdminListQueryV1): SuggestedContactAdminPageV1;
  load(caller: string, query: SuggestedContactAdminLoadQueryV1): SuggestedContactAdminContactV1;
  submit(caller: string, command: SuggestedContactAdminCommandV1): SuggestedContactAdminReceiptV1;
  receipt(caller: string, query: SuggestedContactAdminReceiptQueryV1): SuggestedContactAdminReceiptV1 | null;
}
export function createSuggestedContactAdminService(options: ClarificationAuthority & {
  persistence: Persistence; receipts: ClarificationReceiptStore; now?(): string;
}): SuggestedContactAdminServerService {
  const { persistence, receipts } = options; const { sql } = persistence; const cursors = createClarificationCursors();
  if (receipts.persistence.sql !== sql) throw new PersistenceConflictError('Contact receipts must share the mutation database');
  const now = () => clarificationClock(options.now ?? (() => new Date().toISOString()));
  interface Row { id: string; revision: number; name: string; address: string; enabled: number; createdAt: string; }
  const select = 'SELECT c.id,c.name,c.address,c.enabled,c.createdAt,m.revision FROM trusted_contacts c LEFT JOIN clarification_contact_metadata m ON m.contactId=c.id';
  const decode = (row: Row) => parseSuggestedContactAdminContactV1({ ...row, enabled: row.enabled === 1 });
  const get = (id: string) => {
    const row = sql.prepare(`${select} WHERE c.id=?`).get(id) as Row | undefined;
    return row ? decode(row) : null;
  };
  return {
    list(caller, raw) {
      authorizeClarification(options, caller, 'suggested-contact-admin');
      const query = parseSuggestedContactAdminListQueryV1(raw); const binding = cursors.binding({ caller, scope: 'global', order: 'createdAt-desc-id-desc' });
      const after = query.cursor === null ? null : cursors.decode(query.cursor, binding);
      return persistence.transaction(() => {
        const rows = sql.prepare(`${select} ${after ? 'WHERE (c.createdAt<? OR (c.createdAt=? AND c.id<?))' : ''} ORDER BY c.createdAt DESC,c.id DESC LIMIT ?`)
          .all(...(after ? [after.createdAt, after.createdAt, after.id] : []), query.limit + 1) as Row[];
        const items = rows.slice(0, query.limit).map(decode); const last = items.at(-1);
        return Object.freeze({ version: 1, scope: 'global', items: Object.freeze(items), observedAt: now(),
          nextCursor: rows.length > query.limit && last ? cursors.encode(binding, last) : null });
      });
    },
    load(caller, raw) {
      authorizeClarification(options, caller, 'suggested-contact-admin'); const query = parseSuggestedContactAdminLoadQueryV1(raw);
      return persistence.transaction(() => { const contact = get(query.id); if (!contact) throw new ClarificationServiceError(404, 'not-found'); return contact; });
    },
    submit(caller, raw) {
      authorizeClarification(options, caller, 'suggested-contact-admin'); const command = parseSuggestedContactAdminCommandV1(raw);
      const { requestId, ...input } = command;
      return persistence.transaction(() => {
        const previous = receipts.contact(caller, requestId);
        if (previous) {
          if (stableJson(previous.input) !== stableJson(input)) throw new PersistenceConflictError('Contact request content changed');
          return previous;
        }
        const reject = (reason: NonNullable<SuggestedContactAdminReceiptV1['reason']>) => receipts.saveContact(caller,
          { version: 1, scope: 'global', requestId, input, status: 'rejected', result: null, reason });
        const current = get(input.id);
        if (input.kind === 'create') {
          if (current) return reject('conflict');
          sql.prepare('INSERT INTO trusted_contacts(id,name,address,enabled,createdAt) VALUES(?,?,?,?,?)').run(input.id, input.name, input.address, input.enabled ? 1 : 0, now());
        } else {
          if (!current) return reject('not-found');
          if (current.revision !== input.expectedRevision) return reject('revision-changed');
          const result = sql.prepare(`UPDATE trusted_contacts SET name=?,address=?,enabled=? WHERE id=?
            AND EXISTS(SELECT 1 FROM clarification_contact_metadata WHERE contactId=trusted_contacts.id AND revision=?)`)
            .run(input.name, input.address, input.enabled ? 1 : 0, input.id, input.expectedRevision);
          if (result.changes !== 1) return reject('revision-changed');
        }
        const result = get(input.id);
        if (!result || result.revision !== (input.kind === 'create' ? 1 : input.expectedRevision + 1)) throw new PersistenceConflictError('Contact revision changed unexpectedly');
        return receipts.saveContact(caller, { version: 1, scope: 'global', requestId, input, status: 'succeeded', result, reason: null });
      });
    },
    receipt(caller, raw) {
      authorizeClarification(options, caller, 'suggested-contact-admin'); const query = parseSuggestedContactAdminReceiptQueryV1(raw);
      return persistence.transaction(() => receipts.contact(caller, query.requestId));
    },
  };
}

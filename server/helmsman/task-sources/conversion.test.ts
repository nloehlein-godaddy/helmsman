import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './fixtures.test-support';
import { createSourceConversionCoordinator } from './conversion';
import { registerPersistenceWriter, type Persistence } from '../persistence';
const opened: Persistence[] = [];
const setup = () => { const result = fixture(); opened.push(result.persistence); return result; };
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
describe('existing source ownership conversion', () => {
  it('migrates retained Todo ownership once and reconciles only after original obligations settle', () => {
    const { store, persistence, source } = setup(); persistence.sql.exec('CREATE TABLE runs(id TEXT,ticketId TEXT,repo TEXT,status TEXT,taskJson TEXT); CREATE TABLE execution_checkpoints(runId TEXT,state TEXT);');
    persistence.sql.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('old-run', 'TODO-1', 'owner/project', 'succeeded', JSON.stringify({ todoId: 'TODO-1', ticketId: 'TODO-1', repo: 'owner/project' }));
    persistence.sql.prepare('INSERT INTO execution_checkpoints VALUES (?,?)').run('old-run', 'resumable');
    const conversion = createSourceConversionCoordinator(store); const audit = conversion.audit(); conversion.convert({ expectedAuditHash: audit.hash, todoSourceId: source.id });
    expect(store.activeClaim({ sourceId: source.id, externalId: 'TODO-1' })?.runId).toBe('old-run'); expect(store.quarantines(source.id)).toHaveLength(1);
    conversion.convert({ expectedAuditHash: conversion.audit().hash, todoSourceId: source.id }); expect(store.claims()).toHaveLength(1);
    conversion.reconcile({ sourceIds: [source.id] }); expect(store.quarantines(source.id)).toHaveLength(1);
    persistence.sql.exec("UPDATE execution_checkpoints SET state='retired'"); const stop = registerPersistenceWriter(persistence, 'application');
    try { conversion.reconcile({ sourceIds: [source.id] }); } finally { stop(); }
    expect(store.quarantines(source.id)).toHaveLength(0); expect(store.activeClaim({ sourceId: source.id, externalId: 'TODO-1' })).toBeNull();
  });
  it('quarantines unresolved Jira aliases across the whole source and rejects stale audits', () => {
    const { store, persistence, source, input } = setup(); const jira = store.provision({ ...input, provisioningKey: 'jira', storageLayout: 'remote', identityEvidence: { ...input.identityEvidence, level: 'operator-seeded', authority: null } });
    persistence.sql.exec('CREATE TABLE execution_admissions(runId TEXT,state TEXT,json TEXT)');
    persistence.sql.prepare('INSERT INTO execution_admissions VALUES (?,?,?)').run('old-jira', 'pending', JSON.stringify({ request: { mode: 'ticket', ticketId: 'OLD-1', repo: 'owner/project' } }));
    const conversion = createSourceConversionCoordinator(store); const audit = conversion.audit();
    persistence.sql.exec("UPDATE execution_admissions SET state='blocked'"); expect(() => conversion.convert({ expectedAuditHash: audit.hash, todoSourceId: source.id, jiraSourceId: jira.source.id })).toThrow(/changed/);
    conversion.convert({ expectedAuditHash: conversion.audit().hash, todoSourceId: source.id, jiraSourceId: jira.source.id });
    expect(() => store.assertUnquarantined({ sourceId: jira.source.id, externalId: 'unrelated-new-key' })).toThrow(/quarantined/);
    expect(store.quarantines(source.id)).toHaveLength(0);
  });
  it('does not turn completed historical Todo links into active ownership', () => {
    const { store, persistence, source } = setup(); persistence.sql.exec("CREATE TABLE todos(sequence INTEGER,runId TEXT,state TEXT); INSERT INTO todos VALUES(1,'historical','done')");
    const conversion = createSourceConversionCoordinator(store); conversion.convert({ expectedAuditHash: conversion.audit().hash, todoSourceId: source.id });
    expect(store.claims()).toHaveLength(0); expect(store.quarantines(source.id)).toHaveLength(0);
  });
});

it('keeps Todos available while Jira provisioning waits and fences Jira when it becomes available', () => {
  const { store, persistence, source, input } = setup(); persistence.sql.exec('CREATE TABLE execution_admissions(runId TEXT,state TEXT,json TEXT)');
  persistence.sql.prepare('INSERT INTO execution_admissions VALUES (?,?,?)').run('old-jira', 'pending', JSON.stringify({ request: { mode: 'ticket', ticketId: 'OLD-1', repo: 'owner/project' } }));
  const conversion = createSourceConversionCoordinator(store); conversion.convert({ expectedAuditHash: conversion.audit().hash, todoSourceId: source.id });
  expect(store.source(source.id)?.conversionReady).toBe(true); expect(store.quarantines(source.id)).toHaveLength(0);
  const ledger = persistence.sql.prepare('SELECT json FROM source_conversions').get() as { json: string }; expect(JSON.parse(ledger.json).pendingJira).toBe(true);
  const jira = store.provision({ ...input, provisioningKey: 'jira-later', storageLayout: 'remote', identityEvidence: { ...input.identityEvidence, level: 'operator-seeded', authority: null } });
  expect(jira.source.conversionReady).toBe(false);
  conversion.convert({ expectedAuditHash: conversion.audit().hash, todoSourceId: source.id, jiraSourceId: jira.source.id });
  expect(store.quarantines(jira.source.id)).toHaveLength(1);
});

it('preserves verified historical Todo retry owners without creating active claims', () => {
  const { store, persistence, source, instance } = setup();
  persistence.sql.exec("CREATE TABLE todos(sequence INTEGER,runId TEXT,state TEXT); INSERT INTO todos VALUES(1,'historical','blocked'); CREATE TABLE runs(id TEXT,status TEXT); INSERT INTO runs VALUES('historical','failed')");
  const conversion = createSourceConversionCoordinator(store); conversion.convert({ expectedAuditHash: conversion.audit().hash, todoSourceId: source.id });
  expect(store.activeClaim({ sourceId: source.id, externalId: 'TODO-1' })).toBeNull();
  expect(store.reserveWork({ ref: { sourceId: source.id, externalId: 'TODO-1' }, admissionId: 'retry', runId: 'new-run', retryOf: 'historical', instanceId: instance.id, expectedSourceRevision: source.revision, expectedInstanceRevision: instance.revision }).runId).toBe('new-run');
});

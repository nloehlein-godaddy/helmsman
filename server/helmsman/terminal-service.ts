import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerFromTitle } from '../../src/logic/agentProvider';
import { isContributionId } from '../../src/plugins/manifest';
import { TERMINAL_LIMITS, parseTerminalControlCommandV1, parseTerminalControlReceiptV1, parseTerminalLines, parseTerminalReceiptQueryV1,
  parseTerminalRepo, parseTerminalScreenV1, parseTerminalSnapshotV1, parseTerminalTargetV1, type TerminalControlCommandV1,
  type TerminalControlReceiptV1, type TerminalReceiptQueryV1, type TerminalTargetV1 } from '../../src/plugins/terminal';
import { sourceText } from '../../src/plugins/source-contract-validation';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { persistenceHash, PersistenceValidationError, type Persistence } from './persistence';
import { migrateOwned, validateTableColumns } from './migrations';
import { actionsFor, keysFor } from './cmux/actions';
import type { Bridge } from './cmux/bridge';
import type { CmuxTab } from './cmux/model';

export interface TerminalServerOptions {
  readonly persistence: Persistence;
  readonly bridge: Pick<Bridge, 'listTabs' | 'readScreen' | 'send' | 'sendKey'>;
  sessionIdentity(): string;
  repos(): readonly string[];
  roots(): readonly { readonly repo: string; readonly path: string }[];
  ownership?(): readonly { readonly repo: string; readonly surfaceRef: string; readonly windowRef?: string; readonly workspaceRef?: string }[];
  authorize(caller: string): void;
  pasteImage?(surfaceRef: string, dataBase64: string, mimeType: string): Promise<{ ok: true } | { ok: false; error: string }>;
  now?(): string;
}
interface Row { input: string; receipt: string; owner: string; hash: string }
const DDL = `CREATE TABLE terminal_control_receipts (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, input TEXT NOT NULL, receipt TEXT NOT NULL, owner TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(caller,requestId)
)`;
function providerOf(tab: CmuxTab): string | null { return providerFromTitle(tab.surfaceTitle) ?? (tab.type === 'agent-session' ? 'claude' : null); }
function canonicalPath(value: string): string | null {
  const paths = /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') ? win32 : posix;
  if (!paths.isAbsolute(value) || value.includes('\0') || value.length > 4096) return null;
  let result = paths.normalize(value);
  try { result = realpathSync.native(result); } catch { /* Retained worktrees can be temporarily unavailable. */ }
  return paths === win32 ? result.toLowerCase() : result;
}
function contains(root: string, cwd: string): boolean {
  const paths = /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') ? win32 : posix;
  const relative = paths.relative(root, cwd);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
export function createTerminalService(options: TerminalServerOptions) {
  const { persistence } = options; const { sql } = persistence; const owner = randomUUID();
  const active = new Set<string>(); let queue: Promise<unknown> = Promise.resolve(); let queued = 0;
  migrateOwned(sql, { owner: 'core.terminal-control-receipts', version: 1, checksum: persistenceHash(DDL), tables: ['terminal_control_receipts'],
    validateLegacy: () => null, apply: () => sql.exec(DDL),
    validateCurrent: () => validateTableColumns(sql, 'terminal_control_receipts', ['caller', 'requestId', 'input', 'receipt', 'owner', 'hash']),
  });
  const now = () => options.now?.() ?? new Date().toISOString();
  const identity = (caller: string, requestId: string) => JSON.stringify([caller, requestId]);
  function scope(caller: string, repo: string | null, scopeRepo: string | null) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    options.authorize(caller);
    if (scopeRepo !== null && repo === null) throw new ClarificationServiceError(403, 'forbidden');
    return clarificationScope(options.repos(), scopeRepo, repo);
  }
  function row(caller: string, requestId: string): Row | undefined {
    const saved = sql.prepare('SELECT input,receipt,owner,hash FROM terminal_control_receipts WHERE caller=? AND requestId=?').get(caller, requestId) as Row | undefined;
    if (saved) {
      const command = parseTerminalControlCommandV1(JSON.parse(saved.input));
      const receipt = parseTerminalControlReceiptV1(JSON.parse(saved.receipt), command);
      if (command.requestId !== requestId || saved.hash !== persistenceHash({ caller, command, receipt, owner: saved.owner })) throw new PersistenceValidationError('Terminal receipt integrity failed');
    }
    return saved;
  }
  function receiptOf(caller: string, command: TerminalReceiptQueryV1, saved: Row) {
    const receipt = parseTerminalControlReceiptV1(JSON.parse(saved.receipt), command);
    if (saved.owner === owner && active.has(identity(caller, command.requestId)) && receipt.status === 'recovery-required')
      return parseTerminalControlReceiptV1({ ...receipt, status: 'pending', reason: null });
    return receipt;
  }
  function tabRepo(tab: CmuxTab): string | null | undefined {
    const configured = options.repos(); const candidates = new Set<string>(); const cwd = tab.cwd === null ? null : canonicalPath(tab.cwd);
    if (tab.cwd !== null && !cwd) return undefined;
    for (const root of options.roots()) {
      if (!root || typeof root.path !== 'string') continue;
      const path = canonicalPath(root.path);
      if (path && cwd && contains(path, cwd)) candidates.add(root.repo);
    }
    for (const retained of options.ownership?.() ?? []) {
      if (retained?.surfaceRef === tab.surfaceRef && retained.windowRef === tab.windowRef && retained.workspaceRef === tab.workspaceRef) candidates.add(retained.repo);
    }
    if (candidates.size > 1) return undefined;
    const repo = [...candidates][0] ?? null;
    return repo !== null && !configured.includes(repo) ? undefined : repo;
  }
  async function observe() {
    const session = sourceText(options.sessionIdentity(), 512); const value = await options.bridge.listTabs();
    if (session !== options.sessionIdentity()) throw new ClarificationServiceError(409, 'conflict');
    if (!value || typeof value.connected !== 'boolean' || !Array.isArray(value.tabs) || value.tabs.length > 10_000) throw new ClarificationServiceError(503, 'service-unavailable');
    const counts = new Map<string, number>();
    for (const tab of value.tabs) if (tab?.surfaceRef) counts.set(tab.surfaceRef, (counts.get(tab.surfaceRef) ?? 0) + 1);
    let partial = false;
    const tabs: { raw: CmuxTab; target: TerminalTargetV1 }[] = [];
    if (value.connected) for (const tab of value.tabs) {
      if (!tab || !['terminal', 'agent-session'].includes(tab.type)) continue;
      if (counts.get(tab.surfaceRef) !== 1 || typeof tab.windowRef !== 'string' || typeof tab.workspaceRef !== 'string' || typeof tab.surfaceTitle !== 'string'
        || typeof tab.workspaceTitle !== 'string' || typeof tab.selected !== 'boolean' || tab.cwd !== null && typeof tab.cwd !== 'string') { partial = true; continue; }
      const repo = tabRepo(tab); if (repo === undefined) { partial = true; continue; }
      const revision = persistenceHash({ session, repo, surface: tab.surfaceRef, window: tab.windowRef, workspace: tab.workspaceRef, cwd: tab.cwd, type: tab.type, provider: providerOf(tab) });
      try { tabs.push({ raw: tab, target: parseTerminalTargetV1({ repo, surfaceRef: tab.surfaceRef, revision }) }); }
      catch { partial = true; }
    }
    return { session, connected: value.connected, partial, tabs };
  }
  async function live(caller: string, target: TerminalTargetV1, scopeRepo: string | null) {
    scope(caller, target.repo, scopeRepo); const observed = await observe(); scope(caller, target.repo, scopeRepo);
    const tab = observed.tabs.find(item => item.target.surfaceRef === target.surfaceRef);
    if (!observed.connected || !tab || JSON.stringify(tab.target) !== JSON.stringify(target)) throw new ClarificationServiceError(409, 'conflict');
    return { ...tab, session: observed.session };
  }
  const receipt = (command: TerminalControlCommandV1, status: TerminalControlReceiptV1['status'], reason: string | null) => {
    const { requestId, ...input } = command; return parseTerminalControlReceiptV1({ version: 1, requestId, input, status, reason });
  };
  return Object.freeze({
    async list(caller: string, input: { version: 1; repo: string | null }, scopeRepo: string | null) {
      if (input?.version !== 1) throw new ClarificationServiceError(400, 'invalid-response');
      const repo = parseTerminalRepo(input.repo); scope(caller, repo, scopeRepo); const observed = await observe(); scope(caller, repo, scopeRepo);
      const selected = observed.tabs.filter(tab => repo === null || tab.target.repo === repo);
      return parseTerminalSnapshotV1({ version: 1, repo, connected: observed.connected,
        quality: observed.partial || selected.length > TERMINAL_LIMITS.tabs ? 'partial' : 'complete',
        tabs: selected.slice(0, TERMINAL_LIMITS.tabs).map(({ raw, target }) => ({ target, title: raw.surfaceTitle.slice(0, 1024), workspaceTitle: raw.workspaceTitle.slice(0, 1024),
          type: raw.type, selected: raw.selected, actions: actionsFor(providerOf(raw)).map(action => ({ id: action.action, label: action.label })) })), observedAt: now() });
    },
    async screen(caller: string, input: { target: TerminalTargetV1; lines: number }, scopeRepo: string | null) {
      const target = parseTerminalTargetV1(input?.target); const lines = parseTerminalLines(input?.lines); const current = await live(caller, target, scopeRepo);
      if (current.session !== options.sessionIdentity()) throw new ClarificationServiceError(409, 'conflict');
      const result = await options.bridge.readScreen(target.surfaceRef, lines);
      await live(caller, target, scopeRepo);
      if (!result?.ok || typeof result.text !== 'string') throw new ClarificationServiceError(503, 'service-unavailable');
      return parseTerminalScreenV1({ version: 1, target, text: result.text.slice(-TERMINAL_LIMITS.screen).replaceAll('\0', ''), truncated: result.text.length > TERMINAL_LIMITS.screen, observedAt: now() });
    },
    control(caller: string, value: TerminalControlCommandV1, scopeRepo: string | null): Promise<TerminalControlReceiptV1> {
      const command = parseTerminalControlCommandV1(value); scope(caller, command.target.repo, scopeRepo);
      if (queued >= 256) throw new ClarificationServiceError(503, 'service-unavailable');
      const input = JSON.stringify(command); const key = identity(caller, command.requestId);
      const execute = async () => {
        scope(caller, command.target.repo, scopeRepo);
        const prior = row(caller, command.requestId);
        if (prior) { if (prior.input !== input) throw new ClarificationServiceError(409, 'conflict'); return receiptOf(caller, { repo: command.target.repo, requestId: command.requestId }, prior); }
        let current: Awaited<ReturnType<typeof live>>;
        let rejected: string | null = null;
        try { current = await live(caller, command.target, scopeRepo); }
        catch (error) { if (!(error instanceof ClarificationServiceError)) throw error; rejected = 'Terminal target is no longer available in this scope'; }
        const op = command.operation;
        const keys = !rejected && op.kind === 'action' ? keysFor(providerOf(current!.raw), op.action as never) : null;
        if (op.kind === 'action' && !keys) rejected = 'Action is not available for this terminal';
        if (op.kind === 'image' && !options.pasteImage) rejected = 'Image input is unavailable';
        scope(caller, command.target.repo, scopeRepo);
        if (!rejected && current!.session !== options.sessionIdentity()) rejected = 'Terminal session changed';
        const uncertain = receipt(command, rejected ? 'rejected' : 'recovery-required', rejected ?? 'Inspect the terminal before acknowledging this uncertain input; it will not be sent again');
        const existing = persistence.transaction(() => {
          const saved = row(caller, command.requestId);
          if (saved) { if (saved.input !== input) throw new ClarificationServiceError(409, 'conflict'); return saved; }
          sql.prepare('INSERT INTO terminal_control_receipts VALUES (?,?,?,?,?,?)').run(caller, command.requestId, input, JSON.stringify(uncertain), owner, persistenceHash({ caller, command, receipt: uncertain, owner })); return null;
        });
        if (existing) return receiptOf(caller, { repo: command.target.repo, requestId: command.requestId }, existing);
        if (rejected) return uncertain;
        active.add(key);
        try {
          let ok = false;
          if (op.kind === 'text') ok = (await options.bridge.send(command.target.surfaceRef, op.text, op.enter))?.ok === true;
          else if (op.kind === 'key') ok = (await options.bridge.sendKey(command.target.surfaceRef, op.key))?.ok === true;
          else if (op.kind === 'image') ok = (await options.pasteImage!(command.target.surfaceRef, op.dataBase64, op.mimeType))?.ok === true;
          else {
            ok = true;
            for (const key of keys ?? []) {
              const current = await live(caller, command.target, scopeRepo);
              if (current.session !== options.sessionIdentity()) throw new ClarificationServiceError(409, 'conflict');
              if (!(await options.bridge.sendKey(command.target.surfaceRef, key))?.ok) { ok = false; break; }
            }
          }
          const outcome = ok ? receipt(command, 'succeeded', null) : uncertain;
          persistence.transaction(() => sql.prepare('UPDATE terminal_control_receipts SET receipt=?,hash=? WHERE caller=? AND requestId=?').run(JSON.stringify(outcome), persistenceHash({ caller, command, receipt: outcome, owner }), caller, command.requestId));
          return outcome;
        } catch { return uncertain; }
        finally { active.delete(key); }
      };
      queued++; const result = queue.then(execute).finally(() => { queued--; }); queue = result.catch(() => undefined); return result;
    },
    inspect(caller: string, value: TerminalControlCommandV1, scopeRepo: string | null): TerminalControlReceiptV1 {
      const command = parseTerminalControlCommandV1(value); scope(caller, command.target.repo, scopeRepo);
      const input = JSON.stringify(command);
      return persistence.transaction(() => {
        const saved = row(caller, command.requestId);
        if (saved) {
          if (saved.input !== input) throw new ClarificationServiceError(409, 'conflict');
          return receiptOf(caller, { repo: command.target.repo, requestId: command.requestId }, saved);
        }
        const fenced = receipt(command, 'recovery-required', 'No terminal dispatch was recorded. This request is now blocked from dispatch; inspect the terminal before acknowledging');
        sql.prepare('INSERT INTO terminal_control_receipts VALUES (?,?,?,?,?,?)').run(caller, command.requestId, input, JSON.stringify(fenced), owner, persistenceHash({ caller, command, receipt: fenced, owner }));
        return fenced;
      });
    },
    receipt(caller: string, value: TerminalReceiptQueryV1, scopeRepo: string | null): TerminalControlReceiptV1 | null {
      const query = parseTerminalReceiptQueryV1(value); scope(caller, query.repo, scopeRepo); const saved = row(caller, query.requestId);
      if (!saved) return null;
      const result = parseTerminalControlReceiptV1(JSON.parse(saved.receipt));
      if (result.input.target.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found');
      return receiptOf(caller, query, saved);
    },
  });
}
export type TerminalServerService = ReturnType<typeof createTerminalService>;

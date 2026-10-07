import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureManagedWorktreeIdentity, describeLocalCheckout, repoBasename, withWorktreeMaintenance } from './worktree';

const run = promisify(execFile);
type Checkout = { path: string; commonDirectory: string };
export type LegacyWorkspaceProof =
  | { kind: 'retained'; checkout: Checkout; workspace: string; branchRef: string }
  | { kind: 'orphan'; checkout: Checkout; workspace: string }
  | { kind: 'absent'; checkout: Checkout; workspace: string }
  | { kind: 'blocked'; reason: string };

function managedRecordedPath(path: string, runId: string, repo: string, isolatedPath: string): boolean {
  return isAbsolute(path) && resolve(path) === path && (path === isolatedPath
    || basename(dirname(path)) === '.worktrees' && basename(dirname(dirname(path))) === repoBasename(repo)
      && path === join(dirname(path), runId));
}

async function entry(path: string): Promise<'missing' | 'directory' | 'unsafe'> {
  const value = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!value) return 'missing';
  if (value.isSymbolicLink() || !value.isDirectory()) return 'unsafe';
  return 'directory';
}

async function registeredPaths(checkout: string): Promise<Set<string>> {
  const output = (await run('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
  return new Set(output.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length)));
}

async function canonicalizeMissingPath(path: string): Promise<string> {
  let ancestor = path;
  while (await entry(ancestor) === 'missing') {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Recorded path has no existing filesystem ancestor');
    ancestor = parent;
  }
  if (await entry(ancestor) === 'unsafe'
    && !(process.platform === 'darwin' && ancestor === '/tmp' && await realpath(ancestor) === '/private/tmp')) {
    throw new Error('Recorded path crosses an unsafe filesystem ancestor');
  }
  return join(await realpath(ancestor), relative(ancestor, path));
}

async function isOrphanedManagedWorkspace(workspace: string, commonDirectory: string, runId: string, historicalAdministration: string | null): Promise<boolean> {
  const pointer = join(workspace, '.git');
  const pointerState = await lstat(pointer).catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!pointerState?.isFile() || pointerState.isSymbolicLink() || pointerState.size > 4096) return false;
  const expectedAdministration = join(commonDirectory, 'worktrees', runId);
  const administrationParent = dirname(expectedAdministration);
  const parentState = await entry(administrationParent);
  if (parentState === 'unsafe' || parentState === 'directory' && await realpath(administrationParent) !== administrationParent) return false;
  if (await entry(expectedAdministration) !== 'missing') return false;
  const pointerTarget = (await readFile(pointer, 'utf8')).trim();
  if (pointerTarget === `gitdir: ${expectedAdministration}`) return true;
  return historicalAdministration !== null && pointerTarget === `gitdir: ${historicalAdministration}`
    && await entry(historicalAdministration) === 'missing';
}

export interface LegacyWorkspaceProofInput {
  agentsRoot: string; repo: string; runId: string; recordedWorkspacePath: string | null; isolatedRoot: string;
}

async function proveWithoutLock(input: LegacyWorkspaceProofInput, checkout: ReturnType<typeof describeLocalCheckout>): Promise<LegacyWorkspaceProof> {
  try {
    const checkoutIdentity = { path: checkout.path, commonDirectory: checkout.commonDirectory };
    const agentsRoot = await realpath(input.agentsRoot);
    const isolatedRoot = join(agentsRoot, '.helmsman-docker-workspaces');
    if (resolve(input.isolatedRoot) !== join(resolve(input.agentsRoot), '.helmsman-docker-workspaces')) return { kind: 'blocked', reason: 'Isolated allocation root differs from the managed workspace root' };
    const isolatedPath = join(isolatedRoot, input.runId);
    const recorded = input.recordedWorkspacePath;
    let historicalAdministration: string | null = null;
    if (recorded !== null && !managedRecordedPath(recorded, input.runId, input.repo, isolatedPath)) return { kind: 'blocked', reason: 'Recorded workspace is outside a run-scoped managed path' };
    const current = describeLocalCheckout(input.agentsRoot, input.repo, input.runId);
    if (current.path !== checkout.path || current.commonDirectory !== checkout.commonDirectory || current.workspacePath !== checkout.workspacePath) return { kind: 'blocked', reason: 'Checkout identity changed during proof' };
    const paths = [checkout.workspacePath, isolatedPath, ...(recorded && recorded !== checkout.workspacePath && recorded !== isolatedPath ? [recorded] : [])];
    for (const path of paths) {
      const parent = dirname(path);
      const parentState = await entry(parent);
      if (parentState === 'unsafe') return { kind: 'blocked', reason: 'Workspace parent is not a trusted directory' };
      if (parentState === 'directory' && await realpath(parent) !== parent) return { kind: 'blocked', reason: 'Workspace parent is a filesystem alias' };
    }
    if (recorded && recorded !== checkout.workspacePath && recorded !== isolatedPath) {
      const oldRepo = dirname(dirname(recorded));
      const oldRepoState = await entry(oldRepo);
      if (oldRepoState === 'unsafe') return { kind: 'blocked', reason: 'Recorded checkout is a filesystem alias' };
      if (oldRepoState === 'directory' && await realpath(oldRepo) !== checkout.path) return { kind: 'blocked', reason: 'Recorded checkout is a different live directory' };
      if (oldRepoState === 'missing') historicalAdministration = await canonicalizeMissingPath(join(oldRepo, '.git', 'worktrees', input.runId));
    }
    const isolatedState = await entry(isolatedPath);
    if (isolatedState !== 'missing') return { kind: 'blocked', reason: 'Isolated allocation still exists or has unsafe identity' };
    const oldState = recorded && recorded !== checkout.workspacePath && recorded !== isolatedPath ? await entry(recorded) : 'missing';
    if (oldState !== 'missing') return { kind: 'blocked', reason: 'Recorded workspace still exists or has unsafe identity' };
    const registered = await registeredPaths(checkout.path);
    if (recorded && recorded !== checkout.workspacePath && registered.has(recorded)) return { kind: 'blocked', reason: 'Recorded workspace remains registered with Git' };
    const workspaceState = await entry(checkout.workspacePath);
    if (workspaceState === 'missing') {
      if (registered.has(checkout.workspacePath)) return { kind: 'blocked', reason: 'Missing workspace remains registered with Git' };
      return { kind: 'absent', checkout: checkoutIdentity, workspace: checkout.workspacePath };
    }
    if (workspaceState !== 'directory') return { kind: 'blocked', reason: 'Workspace has unsafe directory identity' };
    if (!registered.has(checkout.workspacePath)) {
      if (await isOrphanedManagedWorkspace(checkout.workspacePath, checkout.commonDirectory, input.runId, historicalAdministration)) return { kind: 'orphan', checkout: checkoutIdentity, workspace: checkout.workspacePath };
      return { kind: 'blocked', reason: 'Workspace exists without verified Git registration' };
    }
    await captureManagedWorktreeIdentity(checkout.path, checkout.workspacePath);
    const branchRef = (await run('git', ['-C', checkout.workspacePath, 'symbolic-ref', '-q', 'HEAD'], { timeout: 10_000 })).stdout.trim();
    if (!branchRef.startsWith('refs/heads/') || branchRef.length <= 'refs/heads/'.length) return { kind: 'blocked', reason: 'Retained workspace has no branch identity' };
    return { kind: 'retained', checkout: checkoutIdentity, workspace: checkout.workspacePath, branchRef };
  } catch (error) { return { kind: 'blocked', reason: error instanceof Error ? error.message : 'Legacy workspace proof failed' }; }
}

export async function withLegacyExecutionWorkspaceProof<T>(input: LegacyWorkspaceProofInput, apply: (proof: LegacyWorkspaceProof) => Promise<T> | T): Promise<T> {
  const checkout = describeLocalCheckout(input.agentsRoot, input.repo, input.runId);
  return withWorktreeMaintenance(checkout.path, async () => apply(await proveWithoutLock(input, checkout)));
}

export async function proveLegacyExecutionWorkspace(input: LegacyWorkspaceProofInput): Promise<LegacyWorkspaceProof> {
  try { return await withLegacyExecutionWorkspaceProof(input, proof => proof); }
  catch (error) { return { kind: 'blocked', reason: error instanceof Error ? error.message : 'Legacy workspace proof failed' }; }
}

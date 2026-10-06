import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Thrown when a Helmsman-owned path would resolve outside the directory that owns it. */
export class OwnedPathError extends Error {}

function assertInside(root: string, path: string): void {
  const offset = relative(realpathSync(root), realpathSync(path));
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new OwnedPathError(`Refusing to use ${path}: it resolves outside ${root}`);
}

function realDirectory(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info?.isDirectory()) return;
  if (info) rmSync(path, { force: true, recursive: true });
  mkdirSync(path, { mode: 0o700 });
}

/**
 * Makes `root` itself a real directory, replacing a symlink or file found there without
 * following it. Only for roots whose parent Helmsman owns but an agent may write into the root.
 */
export function ensureOwnedRoot(root: string): string {
  mkdirSync(dirname(root), { recursive: true });
  realDirectory(root);
  return root;
}

/**
 * Walks `segments` below `root` with `lstat`, replacing any symlink or non-directory component
 * with a fresh `0700` directory, and returns the final path once its realpath is proven to stay
 * under `root`. Existing real directories (and their contents) are kept.
 */
export function ensureOwnedDirectory(root: string, ...segments: string[]): string {
  let path = root;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes(sep)) throw new OwnedPathError(`Invalid owned path segment: ${segment}`);
    path = join(path, segment);
    realDirectory(path);
  }
  assertInside(root, path);
  return path;
}

/**
 * Replaces whatever is at `path` (file, symlink or directory, never followed) with a new file
 * created exclusively, after proving the parent directory resolves under `root`.
 */
export function writeOwnedFile(root: string, path: string, content: string, mode = 0o600): void {
  assertInside(root, dirname(path));
  rmSync(path, { force: true, recursive: true });
  writeFileSync(path, content, { mode, flag: 'wx' });
}

/** Removes the entry at `path` without following it, after proving its parent resolves under `root`. */
export function removeOwnedEntry(root: string, path: string): void {
  assertInside(root, dirname(path));
  rmSync(path, { force: true, recursive: true });
}

/** Reads a regular file, refusing to follow a symlink at the final component; `null` otherwise. */
export function readOwnedFile(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

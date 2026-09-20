import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '.helmsman-distribution.json';
const ignoredSource = /(?:\.test\.[cm]?[jt]s|\.d\.ts)$/;
const nodeMajor = Number(process.versions.node.split('.')[0]);

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function inventory(directory, expected) {
  const entries = [];
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Distribution output must be a real directory without symlinks.');
  async function visit(path) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const absolute = join(path, item.name);
      const local = relative(directory, absolute).split(sep).join('/');
      if (local === marker) continue;
      const prior = expected?.get(local);
      if (expected && !prior) throw new Error(`Refusing to replace distribution with untracked data: ${local}`);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error(`Distribution output contains a symlink or special file: ${local}`);
      if (info.isDirectory()) {
        if (prior && prior.type !== 'directory') throw new Error(`Distribution output was modified: ${local}`);
        entries.push({ path: local, type: 'directory' });
        await visit(absolute);
      } else {
        if (prior && (prior.type !== 'file' || prior.size !== info.size)) throw new Error(`Distribution output was modified: ${local}`);
        const sha256 = createHash('sha256').update(await readFile(absolute)).digest('hex');
        if (prior && prior.sha256 !== sha256) throw new Error(`Distribution output was modified: ${local}`);
        entries.push({ path: local, type: 'file', size: info.size, sha256 });
      }
    }
  }
  await visit(directory);
  if (expected && entries.length !== expected.size) throw new Error('Distribution output is missing managed files or directories.');
  return entries;
}

async function verifyOutput(directory, previousMarker) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Distribution output must be a real directory without symlinks.');
  const markerInfo = await lstat(join(directory, marker)).catch(() => null);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 2 * 1024 * 1024) {
    throw new Error('Refusing to replace a distribution without a verifiable inventory.');
  }
  const bytes = await readFile(join(directory, marker));
  if (previousMarker && !bytes.equals(previousMarker)) throw new Error('Distribution inventory changed during the build.');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value?.version !== 2 || !Array.isArray(value.inventory)) throw new Error('Refusing to replace a distribution without a verifiable inventory.');
  const expected = new Map();
  for (const item of value.inventory) {
    if (!item || typeof item.path !== 'string' || expected.has(item.path)
      || !['directory', 'file'].includes(item.type)
      || item.type === 'file' && (!Number.isSafeInteger(item.size) || item.size < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) {
      throw new Error('Distribution inventory is invalid.');
    }
    expected.set(item.path, item);
  }
  await inventory(directory, expected);
  return bytes;
}

async function walk(directory, visit) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Distribution source cannot contain symlinks: ${path}`);
    if (entry.isDirectory()) await walk(path, visit);
    else if (entry.isFile()) await visit(path);
    else throw new Error(`Distribution source must contain regular files: ${path}`);
  }
}

function transformImports(filename, dependencies) {
  function specifier(node) {
    if (!node || !ts.isStringLiteralLike(node) || !node.text.startsWith('.')) return node;
    const original = node.text;
    const resolved = resolve(dirname(filename), original);
    let source = resolved;
    if (!extname(original)) source += '.ts';
    if (source.endsWith('.ts') || source.endsWith('.mjs') || source.endsWith('.js')) dependencies.add(source);
    const output = source.endsWith('.ts') ? `${original.replace(/\.ts$/, '')}.js` : original;
    return ts.factory.createStringLiteral(output);
  }
  return context => {
    const visit = node => {
      if (ts.isImportDeclaration(node)) return ts.factory.updateImportDeclaration(node, node.modifiers,
        node.importClause, specifier(node.moduleSpecifier), node.attributes);
      if (ts.isExportDeclaration(node)) return ts.factory.updateExportDeclaration(node, node.modifiers,
        node.isTypeOnly, node.exportClause, specifier(node.moduleSpecifier), node.attributes);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
        return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [specifier(node.arguments[0])]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return source => ts.visitNode(source, visit);
  };
}

async function copyDependencies(staging, dependencies) {
  const copied = new Map();
  async function copyPackage(name, from, destination, ancestors = new Map()) {
    const resolver = createRequire(join(from, 'package.json'));
    let source;
    try { source = dirname(resolver.resolve(`${name}/package.json`)); }
    catch {
      source = dirname(resolver.resolve(name));
      while (source !== dirname(source)) {
        if (await exists(join(source, 'package.json'))) {
          const candidate = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
          if (candidate.name === name) break;
        }
        source = dirname(source);
      }
    }
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (manifest.name !== name) throw new Error(`Cannot resolve production dependency ${name}`);
    if (ancestors.get(name) === source) return;
    const target = join(destination, name);
    if (copied.get(target) === source) return;
    if (copied.has(target)) throw new Error(`Conflicting production dependency ${name}`);
    copied.set(target, source);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: true,
      filter: path => path === source || !relative(source, path).split(sep).includes('node_modules') });
    const next = new Map(ancestors).set(name, source);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      await copyPackage(dependency, source, join(target, 'node_modules'), next);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
      try { await copyPackage(dependency, source, join(target, 'node_modules'), next); }
      catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') throw error; }
    }
  }
  for (const name of Object.keys(dependencies).sort()) await copyPackage(name, root, join(staging, 'node_modules'));
}

async function buildSdk(destination, version) {
  const sourceRoot = join(root, 'src', 'plugins');
  const publicModules = new Set(['sdk.ts', 'usage.ts', 'backend.ts', 'services.ts', 'outcomes.ts']);
  const queued = new Set([join(sourceRoot, 'sdk.ts')]);
  await mkdir(destination);
  for (const source of queued) {
    const local = relative(sourceRoot, source);
    if (!publicModules.has(local)) throw new Error(`Public SDK imports a private module: ${local}`);
    const contents = await readFile(source, 'utf8');
    const compilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true };
    const declarations = ts.transpileDeclaration(contents, { fileName: source, compilerOptions, reportDiagnostics: true });
    const runtime = ts.transpileModule(contents, { fileName: source, compilerOptions, reportDiagnostics: true,
      transformers: { after: [transformImports(source, queued)] } });
    if ([...declarations.diagnostics ?? [], ...runtime.diagnostics ?? []].some(item => item.category === ts.DiagnosticCategory.Error)) {
      throw new Error(`Plugin SDK compilation failed: ${local}`);
    }
    const ast = ts.createSourceFile(source, declarations.outputText, ts.ScriptTarget.Latest, true);
    const transformed = ts.transform(ast, [transformImports(source, queued)]);
    try {
      await writeFile(join(destination, local.replace(/\.ts$/, '.d.ts')), ts.createPrinter().printFile(transformed.transformed[0]));
      await writeFile(join(destination, local.replace(/\.ts$/, '.js')), runtime.outputText);
    } finally { transformed.dispose(); }
  }
  await writeFile(join(destination, 'index.d.ts'), "export * from './sdk.js';\n");
  await writeFile(join(destination, 'index.js'), "export * from './sdk.js';\n");
  await writeFile(join(destination, 'package.json'), `${JSON.stringify({ name: '@helmsman/plugin-sdk', version,
    type: 'module', types: './index.d.ts', main: './index.js', exports: { '.': { types: './index.d.ts', import: './index.js' } } }, null, 2)}\n`);
}

export async function buildDistribution(options = {}) {
  const destination = resolve(options.outDir ?? join(root, 'release'));
  const pathFromDestination = relative(destination, root);
  if (destination === root || !pathFromDestination.startsWith('..') && !isAbsolute(pathFromDestination)) {
    throw new Error('Distribution output cannot replace the application source or its parent.');
  }
  const originalMarker = await exists(destination) ? await verifyOutput(destination) : null;
  await readFile(join(root, 'dist', 'index.html'));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.helmsman-build-'));
  try {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const queued = new Set();
    const emitted = new Set();
    await walk(join(root, 'server'), async path => {
      if (!ignoredSource.test(path) && !path.includes(`${sep}test-support${sep}`)) queued.add(path);
    });
    for (const name of ['cmux-codex-cost.mjs', 'install-cmux-codex-cost.mjs']) queued.add(join(root, 'scripts', name));
    for (const source of queued) {
      if (emitted.has(source)) continue;
      emitted.add(source);
      const local = relative(root, source);
      if (local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Runtime import escapes application root: ${source}`);
      const target = join(staging, local.replace(/\.ts$/, '.js'));
      await mkdir(dirname(target), { recursive: true });
      if (/\.[cm]?[jt]s$/.test(source)) {
        const contents = await readFile(source, 'utf8');
        const output = ts.transpileModule(contents, {
          fileName: source,
          compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
            verbatimModuleSyntax: true, newLine: ts.NewLineKind.LineFeed },
          transformers: { after: [transformImports(source, queued)] },
          reportDiagnostics: true,
        });
        if (output.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) {
          throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
            getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
          }));
        }
        await writeFile(target, output.outputText);
      } else await cp(source, target);
    }
    await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
    await cp(join(root, 'examples'), join(staging, 'examples'), { recursive: true });
    for (const name of ['costs', 'pricing']) await cp(join(root, 'src', 'plugins', name), join(staging, 'plugin-sources', name), {
      recursive: true, filter: path => !/\.test\.ts$/.test(path) && !relative(join(root, 'src', 'plugins', name), path).split(sep).some(part => ['node_modules', 'dist'].includes(part)),
    });
    await cp(join(root, 'docker'), join(staging, 'docker'), { recursive: true });
    await copyDependencies(staging, packageJson.dependencies ?? {});
    const runtimePackage = { name: packageJson.name, version: packageJson.version, private: true, type: 'module',
      engines: { node: `>=${nodeMajor}.0.0 <${nodeMajor + 1}.0.0` }, os: [process.platform], cpu: [process.arch],
      scripts: { start: 'node server/helmsman/main.js', plugins: 'node server/helmsman/plugins/cli.js' },
      dependencies: packageJson.dependencies };
    await writeFile(join(staging, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
    await buildSdk(join(staging, 'sdk'), packageJson.version);
    await writeFile(join(staging, marker), `${JSON.stringify({ version: 2, applicationVersion: packageJson.version,
      platform: process.platform, arch: process.arch, nodeMajor, nodeAbi: process.versions.modules,
      inventory: await inventory(staging) }, null, 2)}\n`);
    const previous = `${destination}.previous-${randomUUID()}`;
    if (originalMarker) {
      await verifyOutput(destination, originalMarker);
      await rename(destination, previous);
      try { await verifyOutput(previous, originalMarker); }
      catch (error) { await rename(previous, destination); throw error; }
    } else if (await exists(destination)) throw new Error('Distribution output appeared during the build; it has been preserved.');
    try { await rename(staging, destination); }
    catch (error) { if (originalMarker) await rename(previous, destination); throw error; }
    if (originalMarker) process.stdout.write(`Previous distribution retained: ${previous}\n`);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/build-distribution.mjs');
  const destination = await buildDistribution();
  process.stdout.write(`Runnable distribution: ${destination}\n`);
}

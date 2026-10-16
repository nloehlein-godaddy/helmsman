import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { checkSdkCompatibility } from './sdk-compatibility.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '.helmsman-distribution.json';
const ignoredSource = /(?:\.test\.[cm]?[jt]s|\.d\.ts)$/;
const nodeMajor = Number(process.versions.node.split('.')[0]);
const authorPackages = ['agent-prompts', 'agents-overview', 'product-feedback', 'feedback-github', 'agent-codex', 'agent-claude', 'agent-command', 'host-local', 'host-docker', 'terminal-cmux', 'native-firefox', 'terminal-wezterm', 'scheduling', 'profile', 'execution-settings', 'github-settings', 'jira-settings', 'local-git', 'campaigns', 'terminal', 'compat-pr', 'communication', 'github', 'slack', 'slack-companion', 'slack-oi', 'runs', 'compat-clarifications', 'clarifications', 'suggested-contacts', 'run-viewer', 'run-history', 'costs', 'pricing', 'todos', 'todos-ui', 'source-settings', 'triage', 'bugs', 'jira', 'local-tasks-alternative', 'helm', 'backlog', 'helm-alternative', 'backlog-alternative', 'running', 'recent', 'underway', 'newrun', 'repoprs', 'shipped', 'activity', 'workflow-coding', 'workflow-review', 'trigger-campaign', 'trigger-slack-review', 'trigger-github-review', 'trigger-github-webhook'];
const authorGuides = ['product-feedback.md', 'plugin-quickstart.md', 'plugin-compatibility.md', 'agent-authoring.md', 'execution-host-authoring.md', 'native-terminal-authoring.md', 'scheduling-authoring.md', 'profile-authoring.md', 'integration-settings-authoring.md', 'local-git-authoring.md', 'campaigns-authoring.md', 'terminal-authoring.md', 'communication-authoring.md', 'pull-request-authoring.md', 'panel-authoring.md', 'task-source-authoring.md', 'run-inspect-authoring.md', 'pull-request-inspect-authoring.md', 'download-authoring.md', 'run-presentation-authoring.md', 'clarification-authoring.md', 'authored-clarifications.md', 'clarification-backend.md', 'workflow-authoring.md', 'trigger-authoring.md', 'plugin-packages.md', 'plugin-backend.md', 'plugin-page-registry.md', 'distribution.md', 'helmsman-process.md', 'helmsman-og-integration-2026-09-28.md', 'helmsman-og-integration-2026-10-01.md', 'product-feedback.md', 'run-instructions.md'];

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

function documentLinks(contents, html = false) {
  const blank = value => value.replace(/[^\n]/g, ' ');
  let searchable = contents.replace(/<!--[\s\S]*?-->/g, blank);
  if (!html) {
    searchable = searchable.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*(?:\n|$)/gm, blank)
      .replace(/(`+)[^`]*?\1/g, blank);
  }
  const links = new Map();
  const patterns = html ? [] : [/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g, /^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm];
  for (const pattern of patterns) for (const match of searchable.matchAll(pattern)) {
    const value = match[1] ?? match[2]; const start = match.index + match[0].lastIndexOf(value);
    links.set(start, { start, end: start + value.length, value });
  }
  for (const match of searchable.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
    const value = match[2]; const start = match.index + match[0].lastIndexOf(value);
    links.set(start, { start, end: start + value.length, value });
  }
  return [...links.values()].sort((a, b) => a.start - b.start);
}

export async function copyDistributionDocumentation(staging, options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? root);
  const packages = options.packages ?? authorPackages;
  const mappings = [['examples', 'examples'], ['docker', 'docker'], ...packages.map(name => [`src/plugins/${name}`, `plugin-sources/${name}`])];
  const queued = new Map(); let copiedBytes = 0;
  const localPath = path => relative(sourceRoot, path).split(sep).join('/');
  async function sourceInfo(path) {
    const local = relative(sourceRoot, path);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Documentation link escapes the source repository.');
    for (let current = path; current !== sourceRoot; current = dirname(current)) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Documentation source cannot contain symlinks: ${localPath(path)}`);
    }
    const info = await lstat(path);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Invalid documentation source: ${localPath(path)}`);
    return info;
  }
  function add(source, destination) {
    if (queued.has(source)) return;
    queued.set(source, destination);
  }
  for (const name of options.guides ?? authorGuides) add(join(sourceRoot, 'docs', name), join(staging, 'docs', name));
  for (const [sourceDirectory, outputDirectory] of mappings) {
    const output = join(staging, outputDirectory);
    if (await exists(output)) await walk(output, async path => {
      if (/\.(?:md|html)$/i.test(path)) add(join(sourceRoot, sourceDirectory, relative(output, path)), path);
    });
  }
  async function linkTarget(source, destination, link) {
    if (!link || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(link)) return link;
    const match = /^([^?#]*)([?#].*)?$/.exec(link);
    const rawPath = match?.[1]; if (!rawPath) return link;
    const path = decodeURIComponent(rawPath); const suffix = match[2] ?? '';
    const target = resolve(path.startsWith('/') ? sourceRoot : dirname(source), path.replace(/^\//, ''));
    const info = await sourceInfo(target); const local = localPath(target);
    let output = null;
    if (info.isFile() && (local.startsWith('docs/') && /\.(?:md|html|svg|png|jpe?g|gif|webp|pdf)$/i.test(local) || local === 'README.md')) {
      output = join(staging, local); add(target, output);
    } else for (const [sourceDirectory, outputDirectory] of mappings) {
      if (local === sourceDirectory || local.startsWith(`${sourceDirectory}/`)) {
        const candidate = join(staging, outputDirectory, relative(join(sourceRoot, sourceDirectory), target));
        if (await exists(candidate)) output = candidate;
        break;
      }
    }
    if (output) {
      const path = relative(dirname(destination), output).split(sep).map(encodeURIComponent).join('/');
      return `${path || '.'}${suffix}`;
    }
    return `https://github.com/nloehlein-godaddy/helmsman/${info.isDirectory() ? 'tree' : 'blob'}/master/${local.split('/').map(encodeURIComponent).join('/')}${suffix}`;
  }
  for (const [source, destination] of queued) {
    const info = await sourceInfo(source);
    if (!info.isFile() || info.size > 2 * 1024 * 1024 || (copiedBytes += info.size) > 16 * 1024 * 1024) throw new Error('Distribution documentation exceeds its bounded file budget.');
    const original = await readFile(source);
    await mkdir(dirname(destination), { recursive: true });
    if (!/\.(?:md|html)$/i.test(source)) { await writeFile(destination, original); continue; }
    const contents = original.toString('utf8'); let rendered = ''; let offset = 0;
    for (const link of documentLinks(contents, source.endsWith('.html'))) {
      rendered += contents.slice(offset, link.start) + await linkTarget(source, destination, link.value); offset = link.end;
    }
    await writeFile(destination, rendered + contents.slice(offset));
  }
}

function transformImports(filename, dependencies) {
  function specifier(node) {
    if (!node || !ts.isStringLiteralLike(node)) return node;
    let original = node.text;
    if (original === '@helmsman/plugin-sdk' || original === '@helmsman/plugin-sdk/node') {
      const entry = original.endsWith('/node') ? 'execution-host-node.ts' : 'sdk.ts';
      original = relative(dirname(filename), join(root, 'src/plugins', entry)).split(sep).join('/');
      if (!original.startsWith('.')) original = `./${original}`;
    }
    if (!original.startsWith('.')) return node;
    const resolved = resolve(dirname(filename), original);
    let source = resolved;
    if (!extname(original)) source += '.ts';
    else if (original.endsWith('.js') && !existsSync(source) && existsSync(source.replace(/\.js$/, '.ts'))) source = source.replace(/\.js$/, '.ts');
    if (['.ts', '.mjs', '.js', '.json'].some(extension => source.endsWith(extension))) dependencies.add(source);
    const output = source.endsWith('.ts') && !original.endsWith('.js') ? `${original.replace(/\.ts$/, '')}.js` : original;
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

export async function buildSdk(destination) {
  const metadata = JSON.parse(await readFile(join(root, 'sdk/version.json'), 'utf8'));
  if (metadata?.protocolMajor !== 1 || metadata?.baseline !== 'v1' || !/^1\.\d+\.\d+$/.test(metadata?.version ?? '')) throw new Error('Unsupported SDK release metadata');
  const version = metadata.version;
  const sourceRoot = join(root, 'src', 'plugins');
  const publicModules = new Set(['agent-prompts.ts', 'agent-provider.ts', 'execution-host.ts', 'execution-host-node.ts', 'native-terminal.ts', 'workflow.ts', 'trigger.ts', 'scheduling-provider.ts', 'profile.ts', 'execution-policy.ts', 'github-settings.ts', 'jira-settings.ts', 'local-git.ts', 'campaigns.ts', 'terminal.ts', 'terminal-route.ts', 'sdk.ts', 'usage.ts', 'backend.ts', 'services.ts', 'outcomes.ts', 'tasks.ts', 'composition.ts', 'task-read.ts', 'task-context.ts', 'task-views.ts', 'task-edit.ts', 'todo-legacy-recovery.ts', 'task-editor-contract.ts', 'source-command.ts', 'task-actions.ts', 'task-action-declaration.ts', 'source-settings.ts', 'source-admin.ts', 'source-contract-validation.ts', 'run-read.ts', 'feedback-outcome.ts', 'run-inspect.ts', 'download.ts', 'presentation.ts', 'loading-wheel.ts', 'clarification-read.ts', 'clarification-command.ts', 'suggested-contact-admin.ts', 'clarification-validation.ts', 'run-command.ts', 'run-instructions.ts', 'postmortem.ts', 'whiteboard.ts', 'pull-request-read.ts', 'pull-request-inspect.ts', 'pull-request-command.ts', 'pull-request-provider.ts', 'pull-request-feedback.ts', 'communication-provider.ts', 'communication-connection.ts', 'communication.ts', 'communication-command.ts', 'feedback-command.ts', 'feedback-settings.ts', 'feedback-tracker.ts', 'activity-read.ts']);
  const queued = new Set([join(sourceRoot, 'sdk.ts'), join(sourceRoot, 'execution-host-node.ts')]);
  await mkdir(destination);
  for (const source of queued) {
    const local = relative(sourceRoot, source);
    if (!publicModules.has(local)) throw new Error(`Public SDK imports a private module: ${local}`);
    const contents = await readFile(source, 'utf8');
    const compilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true };
    const declarations = ts.transpileDeclaration(contents, { fileName: source, compilerOptions, reportDiagnostics: true });
    const runtime = ts.transpileModule(contents, { fileName: source, compilerOptions, reportDiagnostics: true,
      transformers: { after: [transformImports(source, queued)] } });
    const diagnostics = [...declarations.diagnostics ?? [], ...runtime.diagnostics ?? []];
    if (diagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) {
      throw new Error(`Plugin SDK compilation failed: ${local}\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n',
      })}`);
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
  await writeFile(join(destination, 'node.d.ts'), "export * from './execution-host-node.js';\n");
  await writeFile(join(destination, 'node.js'), "export * from './execution-host-node.js';\n");
  await writeFile(join(destination, 'package.json'), `${JSON.stringify({ name: '@helmsman/plugin-sdk', version,
    type: 'module', types: './index.d.ts', main: './index.js', exports: {
      '.': { types: './index.d.ts', import: './index.js' },
      './node': { types: './node.d.ts', import: './node.js' },
    } }, null, 2)}\n`);
}

export async function buildDistribution(options = {}) {
  const destination = resolve(options.outDir ?? join(root, 'release'));
  const frontend = resolve(options.frontendDir ?? join(root, 'dist'));
  const pathFromDestination = relative(destination, root);
  if (destination === root || !pathFromDestination.startsWith('..') && !isAbsolute(pathFromDestination)) {
    throw new Error('Distribution output cannot replace the application source or its parent.');
  }
  const originalMarker = await exists(destination) ? await verifyOutput(destination) : null;
  await readFile(join(frontend, 'index.html'));
  await walk(frontend, async () => {});
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
    await cp(frontend, join(staging, 'dist'), { recursive: true });
    await cp(join(root, 'examples'), join(staging, 'examples'), { recursive: true });
    for (const name of authorPackages) await cp(join(root, 'src', 'plugins', name), join(staging, 'plugin-sources', name), {
      recursive: true, filter: path => !/(?:\.(?:test|pw)\.ts|(?:^|[\\/])playwright\.config\.ts)$/.test(path) && !relative(join(root, 'src', 'plugins', name), path).split(sep).some(part => ['node_modules', 'dist'].includes(part)),
    });
    await cp(join(root, 'docker'), join(staging, 'docker'), { recursive: true });
    await copyDistributionDocumentation(staging);
    await copyDependencies(staging, packageJson.dependencies ?? {});
    const runtimePackage = { name: packageJson.name, version: packageJson.version, private: true, type: 'module',
      engines: { node: `>=${nodeMajor}.0.0 <${nodeMajor + 1}.0.0` }, os: [process.platform], cpu: [process.arch],
      scripts: { start: 'node server/helmsman/main.js', plugins: 'node server/helmsman/plugins/cli.js' },
      dependencies: packageJson.dependencies };
    await writeFile(join(staging, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
    await buildSdk(join(staging, 'sdk'));
    checkSdkCompatibility(join(root, 'sdk/baseline/v1'), join(staging, 'sdk'));
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

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export function checkSdkCompatibility(baseline, candidate) {
  const entries = ['index.d.ts', 'node.d.ts'];
  const files = entries.flatMap(entry => [join(baseline, entry), join(candidate, entry)]);
  for (const file of files) if (!existsSync(file)) throw new Error(`Missing SDK entry: ${file}`);
  const options = { strict: true, noEmit: true, skipLibCheck: false,
    types: ['node'], typeRoots: [fileURLToPath(new URL('../node_modules/@types', import.meta.url))],
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const program = ts.createProgram(files, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  }));
  const checker = program.getTypeChecker();
  const failures = [];
  const assignments = [];
  let checked = 0;
  const resolveSymbol = symbol => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const entry of entries) {
    const oldFile = program.getSourceFile(join(baseline, entry));
    const newFile = program.getSourceFile(join(candidate, entry));
    const oldModule = oldFile && checker.getSymbolAtLocation(oldFile);
    const newModule = newFile && checker.getSymbolAtLocation(newFile);
    if (!oldModule || !newModule) throw new Error(`SDK entry is not a module: ${entry}`);
    const next = new Map(checker.getExportsOfModule(newModule).map(symbol => [symbol.name, resolveSymbol(symbol)]));
    for (const exported of checker.getExportsOfModule(oldModule)) {
      const previous = resolveSymbol(exported);
      const current = next.get(exported.name);
      checked++;
      if (!current) { failures.push(`${entry}: removed export ${exported.name}`); continue; }
      for (const kind of ['Type', 'Value']) {
        const flag = ts.SymbolFlags[kind];
        if (!(previous.flags & flag)) continue;
        if (!(current.flags & flag)) { failures.push(`${entry}: removed ${kind.toLowerCase()} ${exported.name}`); continue; }
        const declaration = previous.declarations?.find(value => value.typeParameters?.length);
        const parameters = kind === 'Type' ? declaration?.typeParameters ?? [] : [];
        if (parameters.some(parameter => parameter.constraint)) throw new Error(`Constrained baseline generics require an explicit compatibility fixture: ${exported.name}`);
        const argumentsText = parameters.length ? `<${parameters.map(parameter => parameter.name.text).join(', ')}>` : '';
        const oldType = `${kind === 'Value' ? 'typeof ' : ''}import(${JSON.stringify(join(baseline, entry).replace(/\.d\.ts$/, '.js'))}).${exported.name}${argumentsText}`;
        const newType = `${kind === 'Value' ? 'typeof ' : ''}import(${JSON.stringify(join(candidate, entry).replace(/\.d\.ts$/, '.js'))}).${exported.name}${argumentsText}`;
        // The host accepts one new communication manifest input. Project only that exact
        // access union for old consumers; all previous-to-current assignments stay strict.
        let legacyType = entry === 'index.d.ts' && kind === 'Type' && exported.name === 'PluginBackendDefinition'
          ? `LegacyCommunicationManifest<${newType}>`
          : entry === 'index.d.ts' && kind === 'Type' && exported.name === 'CommunicationProviderDeclaration'
            ? `LegacyCommunicationDeclaration<${newType}>` : newType;
        if (entry === 'index.d.ts' && kind === 'Type') {
          if (exported.name.startsWith('LocalGit')) legacyType = `LegacyLocalGit<${newType}>`;
          else if (['PluginPageServices', 'PluginPanelServicesV1'].includes(exported.name)) legacyType = `LegacyLocalGitServices<${newType}>`;
          else if (['PluginPageContext', 'PluginPanelContext'].includes(exported.name)) legacyType = `LegacyLocalGitContext<${newType}>`;
        }
        if (entry === 'index.d.ts' && kind === 'Type') {
          if (exported.name === 'PluginServiceRequirementV1') legacyType = `LegacyTaskActionRequirement<${legacyType}>`;
          else if (['PluginPageDefinition', 'PluginPanelDefinition', 'RegisteredPluginPage', 'RegisteredPluginPanel', 'PluginManifestV1', 'PluginManifestV2', 'PluginManifest', 'PageResolution'].includes(exported.name)) legacyType = `LegacyTaskActionMetadata<${legacyType}>`;
          else if (exported.name === 'CompositionServiceV1') legacyType = `LegacyTaskActionComposition<${legacyType}>`;
          else if (exported.name === 'PluginPageContext') legacyType = `LegacyTaskActionContext<${legacyType}>`;
          else if (exported.name === 'PluginPageModule') legacyType = `LegacyTaskActionModule<${legacyType}>`;
        }
        const localGitParser = entry === 'index.d.ts' && kind === 'Value' && exported.name.startsWith('parseLocalGit');
        if (localGitParser) legacyType = `LegacyLocalGit<${newType}>`;
        const acceptedType = localGitParser ? `LegacyLocalGitParameters<${newType}>` : newType;
        assignments.push(`function check${assignments.length}${argumentsText}(previous: ${oldType}, current: ${legacyType}) { const oldCheck: ${oldType} = current; const newCheck: ${acceptedType} = previous; }`);
      }
    }
  }
  if (failures.length) throw new Error(`SDK compatibility check failed:\n${failures.join('\n')}`);
  const checkFile = join(candidate, '__compatibility_check.mts');
  const source = `
type LegacyCommunicationAccess<T> = [T] extends [readonly ['browser-session'] | readonly ['provider-network']]
  ? Extract<T, readonly ['browser-session']> : T;
type LegacyCommunicationDeclaration<T> = { [K in keyof T]: K extends 'access' ? LegacyCommunicationAccess<T[K]> : T[K] };
type LegacyCommunicationDeclarations<T> = T extends undefined ? T : { [K in keyof T]: LegacyCommunicationDeclaration<T[K]> };
type LegacyFeedbackCapability<T> = { [K in keyof T]: K extends 'id' ? Exclude<T[K], 'helmsman/feedback-tracker'> : T[K] };
type LegacyFeedbackCapabilities<T> = T extends readonly unknown[] ? { [K in keyof T]: LegacyFeedbackCapability<T[K]> } : T;
type LegacyCommunicationManifest<T> = { [K in keyof T]: K extends 'communications' ? LegacyCommunicationDeclarations<T[K]> : K extends 'provides' ? LegacyFeedbackCapabilities<T[K]> : T[K] };
type LegacyTaskActionRequirement<T> = { [K in keyof T]: K extends 'id' ? Exclude<T[K], 'helmsman/task-action' | 'helmsman/feedback-command' | 'helmsman/feedback-settings'> : T[K] };
type LegacyTaskActionRequirements<T> = T extends readonly unknown[] ? { [K in keyof T]: LegacyTaskActionRequirement<T[K]> } : T;
type LegacyTaskActionMetadata<T> = T extends readonly unknown[] ? { [K in keyof T]: LegacyTaskActionMetadata<T[K]> }
  : T extends object ? { [K in keyof T]: K extends 'requires' ? LegacyTaskActionRequirements<T[K]> : K extends 'pages' | 'panels' | 'page' ? LegacyTaskActionMetadata<T[K]> : T[K] } : T;
type LegacyTaskActionComposition<T> = T extends object ? { [K in keyof T]: K extends 'discover'
  ? T[K] extends (...args: infer A) => infer R ? (...args: A) => LegacyTaskActionMetadata<R> : T[K] : T[K] } : T;
type LegacyTaskActionContext<T> = { [K in keyof T]: K extends 'composition' ? LegacyTaskActionComposition<T[K]> : T[K] };
type LegacyTaskActionModule<T> = { [K in keyof T]: K extends 'mount' ? T[K] extends (...args: infer A) => infer R
  ? (...args: { [I in keyof A]: LegacyTaskActionContext<A[I]> }) => R : T[K] : T[K] };
type ReleaseWorktree = { action: 'release-worktree'; path: string; expectedCommit: string; expectedBranch: string };
type LegacyLocalGit<T> = T extends { action: 'release-worktree' }
  ? Exclude<keyof T, keyof ReleaseWorktree> extends never ? [T] extends [ReleaseWorktree] ? [ReleaseWorktree] extends [T] ? never : T : T : T
  : T extends (...args: infer A) => infer R ? (...args: A) => LegacyLocalGit<R>
  : T extends Promise<infer R> ? Promise<LegacyLocalGit<R>>
  : T extends object ? { [K in keyof T]: LegacyLocalGit<T[K]> } : T;
type LegacyLocalGitParameters<T> = T extends (...args: infer A) => infer R ? (...args: { [K in keyof A]: LegacyLocalGit<A[K]> }) => R : T;
type LegacyLocalGitServices<T> = { [K in keyof T]: K extends 'localGit' ? LegacyLocalGit<T[K]> : T[K] };
type LegacyLocalGitContext<T> = { [K in keyof T]: K extends 'services' ? LegacyLocalGitServices<T[K]> : T[K] };
${assignments.join('\n')}`;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === checkFile
    ? ts.createSourceFile(name, source, languageVersion, true)
    : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const check = ts.createProgram([...files, checkFile], options, host);
  const errors = ts.getPreEmitDiagnostics(check);
  if (errors.length) throw new Error(`SDK compatibility check failed:\n${ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  })}`);
  return checked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (process.argv.length > 3) throw new Error('Usage: node scripts/sdk-compatibility.mjs [SDK_DIRECTORY]');
  const count = checkSdkCompatibility(join(root, 'sdk/baseline/v1'), resolve(process.argv[2] ?? join(root, 'release/sdk')));
  process.stdout.write(`SDK compatibility: ${count} baseline exports checked.\n`);
}

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
        assignments.push(`function check${assignments.length}${argumentsText}(previous: ${oldType}, current: ${newType}) { const oldCheck: ${oldType} = current; const newCheck: ${newType} = previous; }`);
      }
    }
  }
  if (failures.length) throw new Error(`SDK compatibility check failed:\n${failures.join('\n')}`);
  const checkFile = join(candidate, '__compatibility_check.mts');
  const source = assignments.join('\n');
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

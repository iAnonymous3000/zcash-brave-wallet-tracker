// Static scan behind tests/no-live-data.test.ts: finds test code that reads the repository's data/ directory, which
// every refresh rewrites (the refresh workflow runs `npm run check` first, so such a test could block every refresh).
// It works on the TypeScript syntax tree, so comments and prose in strings never count. Two rules:
//
//  path      An expression that builds a path inside <repo>/data: new URL('../data/…', import.meta.url),
//            join/resolve(ROOT or import.meta.dirname …, 'data', …), `${ROOT}/data/…`, or a cwd-relative 'data/…'
//            handed to an fs function. A directory named data under a temporary directory is not affected: its base
//            is not a path the scan can place in the repository.
//  indirect  Code that reads data/ through src: a call to a src function that reaches dataPath()/dataDir() (found by
//            scanning src/, scripts/ and config/, so a new entry point is covered without editing this file), or a
//            reference to a CLI module that does, without TRACKER_DATA_DIR set first in the enclosing test or helper;
//            and any import of a module that reads data/ when it is loaded.
//
// The scan cannot see every dynamic construction (a path assembled from values computed at run time). It is a guard
// against the forms tests actually use; the frozen copy in tests/fixtures/frozen/ is what tests should read.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface Finding {
  file: string;
  line: number;
  rule: 'path' | 'indirect';
  detail: string;
}

type Val = { kind: 'path' | 'str'; value: string; partial: boolean } | null;

const FS_CALLS = new Set([
  'readFileSync', 'readFile', 'existsSync', 'exists', 'statSync', 'stat', 'lstatSync', 'lstat', 'readdirSync', 'readdir',
  'opendirSync', 'opendir', 'accessSync', 'access', 'cpSync', 'cp', 'copyFileSync', 'copyFile', 'createReadStream',
  'openSync', 'open', 'readJson', 'watch', 'watchFile', 'globSync', 'glob', 'realpathSync', 'realpath',
  'writeFileSync', 'writeFile', 'writeJson', 'appendFileSync', 'mkdirSync', 'rmSync', 'rm', 'renameSync', 'unlinkSync',
]);
const SPAWN_CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
const PATH_MODULES = new Set(['node:path', 'path', 'node:path/posix', 'path/posix']);
const URL_MODULES = new Set(['node:url', 'url']);

function parseFile(file: string, text = readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'fixtures' ? [] : walkTs(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function isImportMeta(e: ts.Expression): boolean {
  return ts.isMetaProperty(e) && e.keywordToken === ts.SyntaxKind.ImportKeyword && e.name.text === 'meta';
}

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** Name of a function declared as `function f` or `const f = () => …` / `const f = function …`. */
function functionName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

/** Local import bindings of one module. */
function importsOf(sf: ts.SourceFile): { named: Map<string, { from: string; name: string }>; ns: Map<string, string> } {
  const named = new Map<string, { from: string; name: string }>();
  const ns = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const spec = st.moduleSpecifier.text;
    const from = spec.startsWith('.') ? resolve(dirname(sf.fileName), spec) : spec;
    const b = st.importClause.namedBindings;
    if (st.importClause.name) ns.set(st.importClause.name.text, from); // default import: treated like a namespace
    if (b && ts.isNamespaceImport(b)) ns.set(b.name.text, from);
    if (b && ts.isNamedImports(b)) for (const el of b.elements) named.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
  }
  return { named, ns };
}

/** Evaluates the path-building expressions of one file as far as they are static. */
class PathEval {
  private readonly consts = new Map<string, ts.Expression>();
  private readonly imports: ReturnType<typeof importsOf>;
  private readonly busy = new Set<ts.Node>();
  readonly sf: ts.SourceFile;
  readonly root: string;
  private readonly depth: number;

  constructor(sf: ts.SourceFile, root: string, depth = 0) {
    this.sf = sf;
    this.root = root;
    this.depth = depth;
    const counts = new Map<string, number>();
    const inits = new Map<string, ts.Expression>();
    const bump = (n: string) => counts.set(n, (counts.get(n) ?? 0) + 1);
    const visit = (n: ts.Node): void => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) {
        bump(n.name.text);
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) inits.set(n.name.text, n.initializer);
      }
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) bump(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const [name, init] of inits) if (counts.get(name) === 1) this.consts.set(name, init);
    this.imports = importsOf(sf);
  }

  private pathFn(e: ts.Expression): string | null {
    if (ts.isIdentifier(e)) {
      const imp = this.imports.named.get(e.text);
      return imp && (PATH_MODULES.has(imp.from) || URL_MODULES.has(imp.from)) ? imp.name : null;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const from = this.imports.ns.get(e.expression.text) ?? this.imports.named.get(e.expression.text)?.from;
      return from && (PATH_MODULES.has(from) || URL_MODULES.has(from)) ? e.name.text : null;
    }
    return null;
  }

  evaluate(node: ts.Expression): Val {
    if (this.busy.has(node) || this.depth > 8) return null;
    this.busy.add(node);
    try {
      return this.evalInner(node);
    } finally {
      this.busy.delete(node);
    }
  }

  private evalInner(n: ts.Expression): Val {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) return this.evaluate(n.expression);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return { kind: 'str', value: n.text, partial: false };
    if (ts.isTemplateExpression(n)) {
      let kind: 'path' | 'str' = 'str';
      let value = n.head.text;
      for (const [i, span] of n.templateSpans.entries()) {
        const v = this.evaluate(span.expression);
        if (!v) return { kind, value, partial: true };
        if (i === 0 && value === '' && v.kind === 'path') kind = 'path';
        value += v.value;
        if (v.partial) return { kind, value, partial: true };
        value += span.literal.text;
      }
      return { kind, value, partial: false };
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.evaluate(n.left);
      if (!l || l.partial) return l;
      const r = this.evaluate(n.right);
      return r ? { kind: l.kind, value: l.value + r.value, partial: r.partial } : { ...l, partial: true };
    }
    if (ts.isIdentifier(n)) {
      const init = this.consts.get(n.text);
      if (init) return this.evaluate(init);
      const imp = this.imports.named.get(n.text);
      if (imp && imp.from.endsWith('.ts') && existsSync(imp.from)) return evalExport(imp.from, imp.name, this.root, this.depth + 1);
      return null;
    }
    if (ts.isPropertyAccessExpression(n)) {
      if (isImportMeta(n.expression)) {
        if (n.name.text === 'dirname') return { kind: 'path', value: dirname(this.sf.fileName), partial: false };
        if (n.name.text === 'filename' || n.name.text === 'url') return { kind: 'path', value: this.sf.fileName, partial: false };
        return null;
      }
      if (n.name.text === 'pathname' || n.name.text === 'href') return this.evaluate(n.expression);
      return null;
    }
    if (ts.isCallExpression(n)) {
      if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'process' && n.expression.name.text === 'cwd') return { kind: 'path', value: this.root, partial: false };
      const fn = this.pathFn(n.expression);
      if (fn === 'join' || fn === 'resolve') return this.joinish(fn, n.arguments);
      if (fn === 'fileURLToPath') return n.arguments[0] ? this.evaluate(n.arguments[0]) : null;
      if (fn === 'dirname') {
        const v = n.arguments[0] ? this.evaluate(n.arguments[0]) : null;
        return v && v.kind === 'path' && !v.partial ? { kind: 'path', value: dirname(v.value), partial: false } : null;
      }
      return null;
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' && n.arguments && n.arguments.length === 2) {
      const a = this.evaluate(n.arguments[0]);
      const b = this.evaluate(n.arguments[1]);
      if (!a || !b || b.kind !== 'path' || b.partial) return null;
      if (a.kind === 'path') return a;
      return { kind: 'path', value: resolve(dirname(b.value), a.value), partial: a.partial };
    }
    return null;
  }

  private joinish(fn: 'join' | 'resolve', args: ts.NodeArray<ts.Expression>): Val {
    let cur: Val = null;
    for (const [i, a] of args.entries()) {
      const v = this.evaluate(a);
      if (!v) return cur ? { ...cur, partial: true } : null;
      if (i === 0) cur = v.kind === 'path' ? v : fn === 'resolve' ? { kind: 'path', value: resolve(this.root, v.value), partial: v.partial } : v;
      else if (fn === 'resolve' && v.kind === 'path') cur = v;
      else cur = { kind: cur!.kind, value: cur!.kind === 'path' && fn === 'resolve' ? resolve(cur!.value, v.value) : join(cur!.value, v.value), partial: v.partial };
      if (cur.partial) return cur;
    }
    return cur;
  }
}

const exportCache = new Map<string, Val>();
/** Value of `export const <name> = …` in another module (e.g. ROOT from src/lib/store.ts). */
function evalExport(file: string, name: string, root: string, depth: number): Val {
  const key = `${file}#${name}`;
  if (exportCache.has(key)) return exportCache.get(key)!;
  exportCache.set(key, null);
  const sf = parseFile(file);
  let out: Val = null;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) out = new PathEval(sf, root, depth).evaluate(d.initializer);
  }
  exportCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// What in src reads data/ through dataPath()/dataDir()
// ---------------------------------------------------------------------------

export interface DataReaders {
  /** Exported functions that reach dataPath()/dataDir(), by name. */
  functions: Set<string>;
  /** Modules whose command-line entry (guarded by `import.meta.url === …argv[1]`) reaches them. */
  clis: Set<string>;
  /** Modules that reach them when they are merely imported. */
  onImport: Set<string>;
}

export function dataReaders(root: string): DataReaders {
  const store = resolve(root, 'src/lib/store.ts');
  const files = ['src', 'scripts', 'config'].flatMap((d) => walkTs(join(root, d)));
  const mods = files.map((file) => {
    const sf = parseFile(file);
    const fns = new Map<string, ts.Node>();
    const exported = new Set<string>();
    const top: ts.Node[] = [];
    const isExported = (st: ts.Statement) => ts.canHaveModifiers(st) && !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        fns.set(st.name.text, st);
        if (isExported(st)) exported.add(st.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            fns.set(d.name.text, d.initializer);
            if (isExported(st)) exported.add(d.name.text);
          } else if (d.initializer) top.push(d.initializer);
        }
      } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) exported.add((el.propertyName ?? el.name).text);
      } else if (!ts.isImportDeclaration(st) && !ts.isInterfaceDeclaration(st) && !ts.isTypeAliasDeclaration(st)) top.push(st);
    }
    return { file, sf, fns, exported, top, imports: importsOf(sf) };
  });
  const touching = new Set<string>([`${store}#dataPath`, `${store}#dataDir`]);
  type Mod = (typeof mods)[number];
  const reaches = (m: Mod, node: ts.Node): boolean => {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const from = m.imports.ns.get(n.expression.text);
        if (from && touching.has(`${from}#${n.name.text}`)) { hit = true; return; }
        visit(n.expression);
        return;
      }
      if (ts.isIdentifier(n)) {
        const imp = m.imports.named.get(n.text);
        if ((m.fns.has(n.text) && touching.has(`${m.file}#${n.text}`)) || (imp && touching.has(`${imp.from}#${imp.name}`))) hit = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of mods) for (const [name, node] of m.fns) {
      const key = `${m.file}#${name}`;
      if (!touching.has(key) && reaches(m, node)) { touching.add(key); changed = true; }
    }
  }
  const out: DataReaders = { functions: new Set(), clis: new Set(), onImport: new Set() };
  for (const m of mods) {
    for (const name of m.exported) if (touching.has(`${m.file}#${name}`)) out.functions.add(name);
    for (const node of m.top) {
      if (!reaches(m, node)) continue;
      const cliGuard = ts.isIfStatement(node) && /import\.meta\.url/.test(node.expression.getText(m.sf)) && /process\.argv/.test(node.expression.getText(m.sf));
      (cliGuard ? out.clis : out.onImport).add(m.file);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scan of one test file
// ---------------------------------------------------------------------------

function isDataDirAssignment(n: ts.Node): boolean {
  if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const l = n.left;
  const named = (ts.isPropertyAccessExpression(l) && l.name.text === 'TRACKER_DATA_DIR') || (ts.isElementAccessExpression(l) && ts.isStringLiteral(l.argumentExpression) && l.argumentExpression.text === 'TRACKER_DATA_DIR');
  if (!named || !/^process\.env$/.test((l as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression.getText())) return false;
  // An empty value falls back to data/ (see dataDir() in src/lib/store.ts).
  const r = n.right;
  return !((ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)) && r.text === '') && !(ts.isIdentifier(r) && r.text === 'undefined');
}

function findIn(node: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const mentionsDataDir = (node: ts.Node) => findIn(node, (n) => (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === 'TRACKER_DATA_DIR').length > 0;

export function scanSource(file: string, text: string, root: string, readers: DataReaders): Finding[] {
  const sf = parseFile(file, text);
  const ev = new PathEval(sf, root);
  const data = resolve(root, 'data');
  const inData = (p: string) => p === data || p.startsWith(data + sep);
  const findings: Finding[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const snippet = (n: ts.Node) => n.getText(sf).replace(/\s+/g, ' ').slice(0, 140);
  const report = (n: ts.Node, rule: Finding['rule'], why: string): void => {
    findings.push({ file, line: line(n), rule, detail: `${why}: ${snippet(n)}` });
  };
  const cliPaths = new Set([...readers.clis].map((p) => resolve(p)));
  const cliRel = [...readers.clis].map((p) => relative(root, p).split(sep).join('/'));

  // Same-file helpers whose body sets TRACKER_DATA_DIR (e.g. withDataDir(fn)), and top-level setup that does.
  const helpers = new Map<string, ts.Node>();
  findIn(sf, isFunctionLike).forEach((fn) => {
    const nm = functionName(fn);
    if (nm) helpers.set(nm, fn);
  });
  const protectingHelpers = new Set([...helpers].filter(([, fn]) => findIn(fn, isDataDirAssignment).length > 0).map(([n]) => n));
  const fileLevel = sf.statements.some((st) => ts.isExpressionStatement(st) && (isDataDirAssignment(st.expression) || (ts.isCallExpression(st.expression) && ['before', 'beforeEach'].includes(calleeName(st.expression) ?? '') && st.expression.arguments.some((a) => findIn(a, isDataDirAssignment).length > 0))));

  const isProtected = (node: ts.Node, mode: 'call' | 'cli', seen: Set<string>): boolean => {
    if (fileLevel) return true;
    let outerNamed: string | null = null;
    for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      if (!isFunctionLike(cur) || !cur.body) continue;
      const body = cur.body;
      if (mode === 'call' ? findIn(body, (n) => isDataDirAssignment(n) && n.getEnd() <= node.getStart(sf)).length > 0 : mentionsDataDir(body)) return true;
      const p = cur.parent;
      if (p && ts.isCallExpression(p) && p.arguments.some((a) => a === cur) && protectingHelpers.has(calleeName(p) ?? '')) return true;
      const nm = functionName(cur);
      if (nm) outerNamed = nm;
    }
    if (outerNamed && !seen.has(outerNamed)) {
      seen.add(outerNamed);
      const sites = findIn(sf, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === outerNamed);
      if (sites.length > 0 && sites.every((s) => isProtected(s, mode, seen))) return true;
    }
    return false;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : '';
      if (spec.startsWith('.') && readers.onImport.has(resolve(dirname(file), spec))) report(n, 'indirect', 'imports a module that reads data/ when loaded');
      return;
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a) && a.text.startsWith('.') && readers.onImport.has(resolve(dirname(file), a.text))) report(n, 'indirect', 'imports a module that reads data/ when loaded');
      return;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const v = ev.evaluate(n as ts.Expression);
      if (v && v.kind === 'path' && inData(v.value)) return report(n, 'path', 'builds a path inside data/');
      if (v && v.kind === 'path' && !v.partial && cliPaths.has(v.value) && !isProtected(n, 'cli', new Set())) report(n, 'indirect', `names ${relative(root, v.value)} (reads data/) without TRACKER_DATA_DIR`);
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n) ?? '';
      const first = n.arguments[0];
      if (FS_CALLS.has(name) && first) {
        const v = ev.evaluate(first);
        if (v && v.kind === 'str' && inData(resolve(root, v.value))) return report(n, 'path', 'reads a cwd-relative path inside data/');
      }
      if (SPAWN_CALLS.has(name)) {
        const lits = findIn(n, (x) => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateHead(x)) as (ts.StringLiteral | ts.TemplateHead)[];
        if (lits.some((l) => cliRel.some((r) => l.text.includes(r))) && !isProtected(n, 'cli', new Set())) report(n, 'indirect', 'spawns a CLI that reads data/ without TRACKER_DATA_DIR');
      }
      if (readers.functions.has(name) && !isProtected(n, 'call', new Set())) report(n, 'indirect', `calls ${name}() (reads through dataPath/dataDir) without setting TRACKER_DATA_DIR first`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

/** Scan every TypeScript file under tests/ (fixtures excluded: they are data, not code). */
export function scanTests(root: string, readers = dataReaders(root)): Finding[] {
  return walkTs(join(root, 'tests')).flatMap((f) => scanSource(f, readFileSync(f, 'utf8'), root, readers)).map((x) => ({ ...x, file: relative(root, x.file) }));
}

// Static scan behind tests/no-live-data.test.ts: finds test code that reads the repository's data/ directory, which
// every refresh rewrites (the refresh workflow runs `npm run check` first, so such a test could block every refresh).
// It works on the TypeScript syntax tree, so comments and prose in strings never count. Two rules:
//
//  path      An expression that builds a path inside <repo>/data: new URL('../data/…', import.meta.url),
//            join/resolve(ROOT or import.meta.dirname …, 'data', …), `${ROOT}/data/…`, [ROOT, 'data'].join('/'), or a
//            cwd-relative 'data/…' handed to an fs function. A directory named data under a temporary directory is not
//            affected: its base is not a path the scan can place in the repository.
//  indirect  Code that reads data/ through src: a call to a src function that reaches dataPath()/dataDir() (found by
//            scanning src/, scripts/ and config/, so a new entry point is covered without editing this file; renamed
//            imports and destructured or reassigned bindings are followed), a child process that runs a CLI module that
//            does or an npm script that runs one (`npm run build`, `node --run refresh`, …), unless TRACKER_DATA_DIR is
//            set to a real value first (an empty value, `undefined`, a delete or a restore of the previous value does not
//            count); and any import of a module that reads data/ when it is loaded.
//
// The scan cannot see every dynamic construction (a path assembled from values computed at run time, a command read
// from a file). The runtime trace (tests/live-data-trace.ts, run by tests/no-live-data.test.ts) covers what node itself
// opens; the scan adds the file and line. The frozen copy in tests/fixtures/frozen/ is what tests should read.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

function parseFile(file: string, text = readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

/** Code files under dir (node_modules excluded). Fixture directories are included: a helper placed there is code. */
function walkCode(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walkCode(p);
    return CODE.test(p) && !p.endsWith('.d.ts') ? [p] : [];
  });
}

/** Strips parentheses, type assertions, non-null assertions and await. */
function strip(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else return e;
  }
}

/** Name a call goes to: f(), x.f(), x['f'](), f.call(…)/f.apply(…). */
function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
  let e = strip(call.expression);
  if (ts.isPropertyAccessExpression(e) && (e.name.text === 'call' || e.name.text === 'apply')) e = strip(e.expression);
  return refName(e);
}

/** Name an expression refers to: f, x.f, x['f']. */
function refName(e: ts.Expression): string | null {
  e = strip(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
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

function findIn(node: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const ASSIGNMENT_OPS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Evaluates the path-building expressions of one file as far as they are static. */
class PathEval {
  /** Initializers of variables declared once and never assigned again (const, or let/var that are never reassigned). */
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
    const assigned = new Set<string>();
    const inits = new Map<string, ts.Expression>();
    const bump = (n: string) => counts.set(n, (counts.get(n) ?? 0) + 1);
    const visit = (n: ts.Node): void => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) {
        bump(n.name.text);
        if (ts.isVariableDeclaration(n) && n.initializer) inits.set(n.name.text, n.initializer);
      }
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) bump(n.name.text);
      if (ts.isBinaryExpression(n) && ASSIGNMENT_OPS.has(n.operatorToken.kind) && ts.isIdentifier(n.left)) assigned.add(n.left.text);
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(n.operand) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) assigned.add(n.operand.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const [name, init] of inits) if (counts.get(name) === 1 && !assigned.has(name)) this.consts.set(name, init);
    this.imports = importsOf(sf);
  }

  /** Initializer of a variable declared once and never reassigned. */
  constOf(name: string): ts.Expression | undefined {
    return this.consts.get(name);
  }

  private pathFn(e: ts.Expression): string | null {
    if (ts.isIdentifier(e)) {
      const imp = this.imports.named.get(e.text);
      return imp && (PATH_MODULES.has(imp.from) || URL_MODULES.has(imp.from)) ? imp.name : null;
    }
    if (ts.isPropertyAccessExpression(e)) {
      let base = e.expression;
      // path.posix.join / path.win32.join
      if (ts.isPropertyAccessExpression(base) && (base.name.text === 'posix' || base.name.text === 'win32')) base = base.expression;
      if (!ts.isIdentifier(base)) return null;
      const from = this.imports.ns.get(base.text) ?? this.imports.named.get(base.text)?.from;
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
      // [ROOT, 'data', …].join('/')
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'join') {
        let arr: ts.Expression = strip(n.expression.expression);
        if (ts.isIdentifier(arr)) arr = this.consts.get(arr.text) ?? arr;
        if (ts.isArrayLiteralExpression(arr)) return this.arrayJoin(arr, n.arguments[0]);
      }
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

  private arrayJoin(arr: ts.ArrayLiteralExpression, sepArg: ts.Expression | undefined): Val {
    const s = sepArg ? this.evaluate(sepArg) : { kind: 'str' as const, value: ',', partial: false };
    if (!s || s.partial) return null;
    const parts: string[] = [];
    let kind: 'path' | 'str' = 'str';
    for (const [i, el] of arr.elements.entries()) {
      const v = ts.isSpreadElement(el) ? null : this.evaluate(el);
      if (i === 0 && v?.kind === 'path') kind = 'path';
      if (!v) return parts.length ? { kind, value: this.norm(kind, parts.join(s.value)), partial: true } : null;
      parts.push(v.value);
      if (v.partial) return { kind, value: this.norm(kind, parts.join(s.value)), partial: true };
    }
    return { kind, value: this.norm(kind, parts.join(s.value)), partial: false };
  }

  private norm(kind: 'path' | 'str', value: string): string {
    return kind === 'path' ? resolve(value) : value;
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
  /** package.json scripts that run one of those CLIs, directly or through another such script. */
  scripts: Set<string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIFECYCLE = new Set(['start', 'stop', 'restart', 'test']);

/** Whether a command line runs the package script `name` (npm run, npm run-script, node --run, yarn/pnpm/bun). */
export function runsScript(command: string, name: string): boolean {
  const n = escapeRe(name);
  const end = `(?=$|["'\`\\s;&|)])`;
  if (new RegExp(`(?:^|["'\`\\s=;&|(])(?:run|run-script|rum|urn|--run)(?:\\s+-{1,2}[\\w-]+(?:=\\S+)?)*(?:\\s+|=)["']?${n}${end}`).test(command)) return true;
  if (new RegExp(`(?:^|["'\`\\s;&|(])(?:yarn|pnpm|bun)(?:\\s+-{1,2}[\\w-]+(?:=\\S+)?)*\\s+${n}${end}`).test(command)) return true;
  return LIFECYCLE.has(name) && new RegExp(`(?:^|["'\`\\s;&|(])npm(?:\\s+-{1,2}[\\w-]+(?:=\\S+)?)*\\s+${n}${end}`).test(command);
}

export function dataReaders(root: string): DataReaders {
  const store = resolve(root, 'src/lib/store.ts');
  const files = ['src', 'scripts', 'config'].flatMap((d) => walkCode(join(root, d)));
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
  const out: DataReaders = { functions: new Set(), clis: new Set(), onImport: new Set(), scripts: new Set() };
  for (const m of mods) {
    for (const name of m.exported) if (touching.has(`${m.file}#${name}`)) out.functions.add(name);
    for (const node of m.top) {
      if (!reaches(m, node)) continue;
      const cliGuard = ts.isIfStatement(node) && /import\.meta\.url/.test(node.expression.getText(m.sf)) && /process\.argv/.test(node.expression.getText(m.sf));
      (cliGuard ? out.clis : out.onImport).add(m.file);
    }
  }
  // npm scripts that run a CLI that reads data/ (refresh, build, dev today), or another such script.
  const pkg = join(root, 'package.json');
  const scripts = existsSync(pkg) ? ((JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
  const cliRel = [...out.clis].map((p) => relative(root, p).split(sep).join('/'));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, command] of Object.entries(scripts)) {
      if (out.scripts.has(name)) continue;
      if (cliRel.some((r) => command.includes(r)) || [...out.scripts].some((s) => runsScript(command, s))) { out.scripts.add(name); changed = true; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scan of one test file
// ---------------------------------------------------------------------------

/** The data/ directory of a repository root, for the guard to name what it watches. A call anywhere else is reported. */
export function liveDataDir(root: string): string {
  return resolve(root, 'data');
}

const isProcessEnv = (e: ts.Expression) => /^process\.env$/.test(strip(e).getText());

/** process.env.TRACKER_DATA_DIR or process.env['TRACKER_DATA_DIR']. */
function isEnvDataDir(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'TRACKER_DATA_DIR') return isProcessEnv(n.expression);
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'TRACKER_DATA_DIR') return isProcessEnv(n.expression);
  return false;
}

const propName = (p: ts.ObjectLiteralElementLike): string | null =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;

export function scanSource(file: string, text: string, root: string, readers: DataReaders): Finding[] {
  const sf = parseFile(file, text);
  const ev = new PathEval(sf, root);
  const imports = importsOf(sf);
  const data = resolve(root, 'data');
  const inData = (p: string) => p === data || p.startsWith(data + sep);
  const findings: Finding[] = [];
  const reported = new Set<string>();
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const snippet = (n: ts.Node) => n.getText(sf).replace(/\s+/g, ' ').slice(0, 140);
  const report = (n: ts.Node, rule: Finding['rule'], why: string): void => {
    const key = `${n.getStart(sf)}:${rule}`;
    if (reported.has(key)) return;
    reported.add(key);
    findings.push({ file, line: line(n), rule, detail: `${why}: ${snippet(n)}` });
  };
  const cliPaths = new Set([...readers.clis].map((p) => resolve(p)));
  const cliRel = [...readers.clis].map((p) => relative(root, p).split(sep).join('/'));

  // --- Names: which local names stand for a reader function, a spawn function or an fs function.
  const WATCHED = (name: string) => readers.functions.has(name) || SPAWN_CALLS.has(name) || FS_CALLS.has(name);
  const aliases = new Map<string, string>();
  for (const [local, imp] of imports.named) if (local !== imp.name) aliases.set(local, imp.name);
  for (const b of findIn(sf, (n) => ts.isBindingElement(n) && ts.isIdentifier(n.name) && !!n.propertyName) as ts.BindingElement[]) {
    const pn = b.propertyName!;
    if (ts.isIdentifier(pn) || ts.isStringLiteralLike(pn)) aliases.set((b.name as ts.Identifier).text, pn.text);
  }
  const original = (name: string): string => aliases.get(name) ?? name;
  const decls = findIn(sf, (n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !!n.initializer) as ts.VariableDeclaration[];
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      let e = strip(d.initializer!);
      if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'bind') e = strip(e.expression.expression);
      const ref = refName(e);
      const target = ref === null ? null : original(ref);
      const local = (d.name as ts.Identifier).text;
      if (target && target !== local && WATCHED(target) && aliases.get(local) !== target) { aliases.set(local, target); changed = true; }
    }
  }

  // --- TRACKER_DATA_DIR: what protects a call, and what undoes the protection.
  const restoreVars = new Set(decls.filter((d) => findIn(d.initializer!, isEnvDataDir).length > 0).map((d) => (d.name as ts.Identifier).text));
  /** A value that keeps data/ out: not empty, undefined or null, and not the previous value put back. */
  const protects = (v: ts.Expression): boolean => {
    const e = strip(v);
    if (ts.isStringLiteralLike(e) && e.text === '') return false;
    if ((ts.isIdentifier(e) && e.text === 'undefined') || e.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(e)) return false;
    return findIn(e, (n) => isEnvDataDir(n) || (ts.isIdentifier(n) && restoreVars.has(n.text))).length === 0;
  };
  /** true/false for an assignment or delete of process.env.TRACKER_DATA_DIR (whether it protects), null otherwise. */
  const envEffect = (n: ts.Node): boolean | null => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isEnvDataDir(n.left)) return protects(n.right);
    if (ts.isDeleteExpression(n) && isEnvDataDir(n.expression)) return false;
    return null;
  };
  /** Effect of the last assignment/delete in scope that ends before pos, or null when there is none. */
  const lastEffectBefore = (scope: ts.Node, pos: number): boolean | null => {
    let best: { end: number; v: boolean } | null = null;
    findIn(scope, (n) => {
      const v = envEffect(n);
      if (v !== null && n.getEnd() <= pos && (!best || n.getEnd() > best.end)) best = { end: n.getEnd(), v };
      return false;
    });
    return best === null ? null : (best as { v: boolean }).v;
  };

  // Same-file helpers that set TRACKER_DATA_DIR before calling the callback they are given (e.g. withDataDir(fn)).
  const helpers = new Map<string, ts.FunctionLikeDeclaration>();
  findIn(sf, isFunctionLike).forEach((fn) => {
    const nm = functionName(fn);
    if (nm) helpers.set(nm, fn as ts.FunctionLikeDeclaration);
  });
  const helperProtects = (name: string | null): boolean => {
    const fn = name ? helpers.get(name) : undefined;
    if (!fn?.body) return false;
    const params = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
    const calls = findIn(fn.body, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && params.has(n.expression.text));
    return calls.length > 0 && calls.every((c) => lastEffectBefore(fn.body!, c.getStart(sf)) === true);
  };
  // Module level: code at the top of the file runs in order; tests and hooks run after all of it, before() hooks first.
  const topLevelEffect = (pos: number): boolean | null => {
    let best: { end: number; v: boolean } | null = null;
    const visit = (n: ts.Node): void => {
      if (isFunctionLike(n)) return;
      const v = envEffect(n);
      if (v !== null && n.getEnd() <= pos && (!best || n.getEnd() > best.end)) best = { end: n.getEnd(), v };
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return best === null ? null : (best as { v: boolean }).v;
  };
  const hookProtects = sf.statements.some((st) => ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ['before', 'beforeEach'].includes(calleeName(st.expression) ?? '') && st.expression.arguments.some((a) => isFunctionLike(a) && !!a.body && lastEffectBefore(a.body, a.body.getEnd()) === true));
  const fileLevel = (node: ts.Node): boolean => {
    let inFunction = false;
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) if (isFunctionLike(cur)) inFunction = true;
    return inFunction ? hookProtects || topLevelEffect(Number.POSITIVE_INFINITY) === true : topLevelEffect(node.getStart(sf)) === true;
  };

  /** Whether process.env.TRACKER_DATA_DIR holds a protecting value when node runs. */
  const callProtected = (node: ts.Node, seen = new Set<string>()): boolean => {
    let outerNamed: string | null = null;
    for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      if (!isFunctionLike(cur) || !cur.body) continue;
      const v = lastEffectBefore(cur.body, node.getStart(sf));
      if (v !== null) return v;
      const p = cur.parent;
      if (p && ts.isCallExpression(p) && p.arguments.some((a) => a === cur) && helperProtects(calleeName(p))) return true;
      const nm = functionName(cur);
      if (nm) outerNamed = nm;
    }
    if (fileLevel(node)) return true;
    if (outerNamed && !seen.has(outerNamed)) {
      seen.add(outerNamed);
      const sites = findIn(sf, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === outerNamed);
      if (sites.length > 0 && sites.every((s) => callProtected(s, seen))) return true;
    }
    return false;
  };

  /** An object literal, directly or through a variable declared once. */
  const objectOf = (e: ts.Expression | undefined): ts.ObjectLiteralExpression | null => {
    if (!e) return null;
    let x = strip(e);
    if (ts.isIdentifier(x)) x = ev.constOf(x.text) ?? x;
    x = strip(x);
    return ts.isObjectLiteralExpression(x) ? x : null;
  };
  /** Strings a child-process call is given: literals, template text, and the static values of its arguments. */
  const commandText = (call: ts.CallExpression): string => {
    const parts: string[] = [];
    for (const a of call.arguments) {
      const items = ts.isArrayLiteralExpression(strip(a)) ? [...(strip(a) as ts.ArrayLiteralExpression).elements] : [a];
      for (const it of items) {
        const v = ts.isSpreadElement(it) ? null : ev.evaluate(it);
        if (v) parts.push(v.value);
        for (const l of findIn(it, (x) => ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x))) parts.push((l as ts.StringLiteral).text);
      }
    }
    return parts.join(' ');
  };
  const namesCliPath = (node: ts.Node): boolean =>
    findIn(node, (x) => ts.isExpression(x) && (() => {
      const v = ev.evaluate(x);
      return !!v && v.kind === 'path' && !v.partial && cliPaths.has(v.value);
    })()).length > 0;
  /** What a child process started by call does: runs a CLI that reads data/ (directly or through an npm script). */
  const runsReader = (call: ts.CallExpression): string | null => {
    const cmd = commandText(call);
    const cli = cliRel.find((r) => cmd.includes(r));
    if (cli) return cli;
    const script = [...readers.scripts].find((s) => runsScript(cmd, s));
    if (script) return `the npm script "${script}"`;
    return call.arguments.some((a) => namesCliPath(a)) ? 'a CLI module' : null;
  };
  /** Whether a child process gets a protecting TRACKER_DATA_DIR: from its env option, an inline VAR=value, or inherited. */
  const spawnProtected = (call: ts.CallExpression): boolean => {
    if (/(?:^|[\s"'`;&|(])TRACKER_DATA_DIR=(?!["']?(?:$|[\s"'`;&|)]))/.test(commandText(call))) return true;
    const opts = [...call.arguments].reverse().map(objectOf).find((o) => o !== null) ?? null;
    const envProp = opts?.properties.find((p) => propName(p) === 'env');
    if (!envProp) return callProtected(call); // no env option: the child inherits process.env
    const envExpr = ts.isPropertyAssignment(envProp) ? envProp.initializer : ts.isShorthandPropertyAssignment(envProp) ? envProp.name : null;
    if (envExpr && isProcessEnv(envExpr)) return callProtected(call);
    const env = objectOf(envExpr ?? undefined);
    if (!env) return false; // an env built elsewhere: cannot be shown to set it
    let state: boolean | 'inherit' | 'none' | 'unknown' = 'none';
    for (const p of env.properties) {
      if (ts.isSpreadAssignment(p)) state = isProcessEnv(p.expression) ? 'inherit' : 'unknown';
      else if (propName(p) === 'TRACKER_DATA_DIR') state = ts.isPropertyAssignment(p) ? protects(p.initializer) : ts.isShorthandPropertyAssignment(p) ? protects(p.name) : false;
    }
    return state === 'inherit' ? callProtected(call) : state === true;
  };
  const isSpawn = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && SPAWN_CALLS.has(original(calleeName(n) ?? ''));
  const checkSpawn = (call: ts.CallExpression): void => {
    const what = runsReader(call);
    if (what && !spawnProtected(call)) report(call, 'indirect', `starts ${what} (reads data/) without a TRACKER_DATA_DIR`);
  };
  /** A path to a CLI named outside a child-process call: follow the variable it is stored in to the calls that use it. */
  const checkCliName = (n: ts.Node): void => {
    for (let cur: ts.Node | undefined = n.parent; cur && !isFunctionLike(cur) && !ts.isSourceFile(cur); cur = cur.parent) if (isSpawn(cur)) return; // checked as that call
    let holder: ts.Node = n;
    while (holder.parent && (ts.isPropertyAccessExpression(holder.parent) || ts.isParenthesizedExpression(holder.parent) || ts.isAsExpression(holder.parent))) holder = holder.parent;
    if (holder.parent && ts.isVariableDeclaration(holder.parent) && ts.isIdentifier(holder.parent.name) && holder.parent.initializer === holder) {
      const name = holder.parent.name.text;
      let scope: ts.Node = holder.parent;
      while (scope.parent && !isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      const users = findIn(scope, (x) => isSpawn(x) && findIn(x, (y) => ts.isIdentifier(y) && y.text === name).length > 0) as ts.CallExpression[];
      if (users.length > 0) {
        for (const u of users) if (!spawnProtected(u)) report(u, 'indirect', `starts ${relative(root, cliOf(n))} (reads data/) without a TRACKER_DATA_DIR`);
        return;
      }
    }
    // Handed on (to a helper, or into a command string): it counts as protected only if the code around it sets a real
    // TRACKER_DATA_DIR, as an env property for the child or as process.env before this point.
    for (let cur: ts.Node | undefined = n.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      if (!isFunctionLike(cur) || !cur.body) continue;
      if (findIn(cur.body, (x) => (ts.isPropertyAssignment(x) && propName(x) === 'TRACKER_DATA_DIR' && protects(x.initializer))).length > 0) return;
    }
    if (callProtected(n)) return;
    report(n, 'indirect', `names ${relative(root, cliOf(n))} (reads data/) without a TRACKER_DATA_DIR`);
  };
  const cliOf = (n: ts.Node): string => ev.evaluate(n as ts.Expression)?.value ?? '';

  /** File a module specifier names, relative to this file (bare package names are not files). */
  const moduleFile = (spec: Val): string | null => {
    if (!spec || spec.partial) return null;
    if (spec.kind === 'path') return resolve(spec.value);
    if (spec.value.startsWith('.')) return resolve(dirname(file), spec.value);
    if (spec.value.startsWith('/')) return resolve(spec.value);
    if (spec.value.startsWith('file:')) return resolve(new URL(spec.value).pathname);
    return null;
  };
  const checkModule = (n: ts.Node, target: string | null): void => {
    if (!target) return;
    if (inData(target)) report(n, 'path', 'imports a file inside data/');
    else if (readers.onImport.has(target)) report(n, 'indirect', 'imports a module that reads data/ when loaded');
  };
  // require() and functions made by createRequire()
  const requireNames = new Set(['require', ...decls.filter((d) => { const e = strip(d.initializer!); return ts.isCallExpression(e) && original(calleeName(e) ?? '') === 'createRequire'; }).map((d) => (d.name as ts.Identifier).text)]);

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      if (ts.isStringLiteral(n.moduleSpecifier)) checkModule(n, moduleFile({ kind: 'str', value: n.moduleSpecifier.text, partial: false }));
      return;
    }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && requireNames.has(n.expression.text)))) {
      if (n.arguments[0]) checkModule(n, moduleFile(ev.evaluate(n.arguments[0])));
      return ts.forEachChild(n, visit);
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const v = ev.evaluate(n as ts.Expression);
      if (v && v.kind === 'path' && inData(v.value)) return report(n, 'path', 'builds a path inside data/');
      if (v && v.kind === 'path' && !v.partial && cliPaths.has(v.value)) checkCliName(n);
    }
    if (ts.isCallExpression(n)) {
      const name = original(calleeName(n) ?? '');
      const first = n.arguments[0];
      if (FS_CALLS.has(name) && first) {
        const v = ev.evaluate(first);
        if (v && v.kind === 'str' && inData(resolve(root, v.value))) return report(n, 'path', 'reads a cwd-relative path inside data/');
        // A recursive copy, listing or removal of a directory that holds data/ (e.g. cpSync(ROOT, tmp)) reaches it too.
        const recursive = /^cp(Sync)?$/.test(name) || n.arguments.slice(1).some((a) => objectOf(a)?.properties.some((p) => propName(p) === 'recursive' && ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.TrueKeyword));
        const dir = v && !v.partial ? (v.kind === 'path' ? resolve(v.value) : resolve(root, v.value)) : null;
        if (recursive && dir && data.startsWith(dir + sep)) return report(n, 'path', 'works recursively on a directory that contains data/');
      }
      // liveDataDir() names data/ for the guard (tests/no-live-data.test.ts, checked by review); anywhere else it is a read.
      if (name === 'liveDataDir' && basename(file) !== 'no-live-data.test.ts') report(n, 'path', 'names data/ through liveDataDir()');
      if (SPAWN_CALLS.has(name)) checkSpawn(n);
      if (readers.functions.has(name) && !callProtected(n)) report(n, 'indirect', `calls ${name}() (reads through dataPath/dataDir) without setting TRACKER_DATA_DIR first`);
      // A reader function handed to other code (a helper, a mock, Promise.then) runs there: the same rule applies here.
      for (const a of n.arguments) {
        const ref = ts.isIdentifier(strip(a)) || ts.isPropertyAccessExpression(strip(a)) ? refName(a) : null;
        const target = ref === null ? null : original(ref);
        if (target && readers.functions.has(target) && !helperProtects(calleeName(n)) && !callProtected(n)) report(a, 'indirect', `hands ${target}() (reads through dataPath/dataDir) to other code without setting TRACKER_DATA_DIR first`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

/** Scan every code file under tests/ (fixture directories included). */
export function scanTests(root: string, readers = dataReaders(root)): Finding[] {
  return walkCode(join(root, 'tests')).flatMap((f) => scanSource(f, readFileSync(f, 'utf8'), root, readers)).map((x) => ({ ...x, file: relative(root, x.file) }));
}

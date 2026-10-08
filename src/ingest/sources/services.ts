// Public server-side signals that change Zcash behaviour without a browser release:
//  - brave/gate3 (swap/bridge routing backend): whether Zcash is in SWAP_DISABLED_CHAINS
//  - brave/brave-variations (Griffin field trials): studies touching Zcash features/params
// Both are read from the public repositories; the deployed services could differ from
// the repository state, which the site states explicitly.
//
// The two components are independent: when one cannot be re-read, its last good value
// is kept (with its own read time) and the source is reported partial, so an outage
// never reads as "no study" or "switch not set".

import { createHash } from 'node:crypto';
import type { Channel, ChannelVersion, Platform } from '../../lib/types.ts';
import type { Collector } from '../framework.ts';
import type { ReleasesData } from './releases.ts';
import { compareVersions } from '../../lib/util.ts';

export interface StudyExperiment {
  name: string;
  /** probability_weight as written in the study. */
  weight: number;
  /** Share of the study's enrolled clients, in percent (weight / total weight); null when every weight is 0. */
  share: number | null;
  enable: string[];
  disable: string[];
  params: Record<string, string>;
  /** forcing_feature_on/off: features whose command-line activation forces a client into this cohort (not a setting the cohort applies). */
  forcingOn?: string[];
  forcingOff?: string[];
}

/** Build-level eligibility of one current build (platform × channel × version) under a study's filter. */
export interface StudyApplicability {
  build: string;
  /** Only determinate answers are listed here; undeterminable builds go to `appliesUnknown`. */
  applies: boolean;
  platform?: Platform;
  channel?: Channel;
  version?: string;
  reason?: string;
  /**
   * Desktop only, when the entry does not cover every desktop OS: the versions.brave.com OS pointers it covers
   * ("windows-x64", ...), or for an aggregate desktop build the OS families the platform filter admits ("WINDOWS", ...).
   * The OSes are also named in `build`.
   */
  desktopOs?: string[];
}

export interface StudyInfo {
  file: string;
  name: string;
  /**
   * Features some enrolled cohort (experiment with weight > 0) enables / disables while no enrolled cohort sets the
   * opposite; a parameter appears when every cohort that sets it uses the same value. Settings that differ between
   * enrolled cohorts are listed in `mixed` and attributed per cohort (with weights) in `experiments`.
   */
  features: { enable: string[]; disable: string[] };
  params: Record<string, string>;
  minVersion: string | null;
  maxVersion: string | null;
  channels: string[];
  platforms: string[];
  probability: number | null;
  /**
   * Determinate eligibility per current platform × channel build (desktop per OS pointer, grouped by outcome), labelled
   * with the Chromium-based version the study's range is compared with ("Desktop release 1.97.56 (155.1.97.56)").
   */
  appliesTo: StudyApplicability[];
  url: string;
  /** Every experiment (cohort) with its weight and own settings. */
  experiments?: StudyExperiment[];
  /** Features/params whose setting differs between enrolled cohorts, including set in some and not in others. */
  mixed?: { features: string[]; params: string[] };
  /** Client-level filter conditions that public data cannot decide (country, locale, policy, ...). */
  conditions?: string[];
  /** Builds whose eligibility could not be determined (e.g. Chromium version unknown, unsupported filter key). */
  appliesUnknown?: { build: string; platform: Platform; channel: Channel; version: string; reason: string }[];
  /** Raw filter, kept so applicability can be recomputed for new builds without refetching the file. */
  filter?: Record<string, unknown>;
  /** When this study's file was last read successfully. */
  readAt?: string | null;
}

export interface Gate3Info {
  commitSha: string;
  file: string;
  zcashDisabled: boolean | null;
  line: number | null;
  url: string;
  checkedAt: string;
  /** Why zcashDisabled is null at this commit. */
  reason?: string | null;
  /** The last determinate reading, kept when the switch can no longer be evaluated. */
  lastDetermined?: { zcashDisabled: boolean; commitSha: string; checkedAt: string; url: string; line: number | null } | null;
}

export interface ServicesData {
  gate3: Gate3Info | null;
  studies: StudyInfo[];
  studiesCommit: string | null;
  /** When the brave-variations listing was last read successfully (studies may be older if carried over). */
  studiesReadAt?: string | null;
  /** Digest of the studies/ listing (names, blob SHAs) and selection rules the studies were read at; an unchanged listing is not re-read. */
  studiesDigest?: string | null;
  /** Study files of that listing that could not be read yet (failed or deferred); retried next run. */
  studyPending?: string[];
}

const GATE3_FILE = 'app/api/swap/constants.py';
/** Bump when relevance or parsing rules change, so an unchanged listing is still re-read. */
export const STUDY_RULES = 4;
/** Upper bound on raw study files fetched per run (the repository has ~125; an unchanged listing is not re-read). */
export const MAX_STUDY_FETCHES = 220;
/**
 * Zcash terms. File level: the file must mention one somewhere. Study level: a feature name (enable/disable/forcing),
 * parameter name or parameter value must contain one (BraveWalletZCash, zcash_shielded_transactions_enabled,
 * zcash_ironwood_enabled, ...). Every Zcash feature and parameter Brave defines contains "zcash" or "ironwood";
 * other Brave Wallet features (BraveWalletWebUIFeature, BraveWalletCardano, ...) do not make a study relevant.
 */
const RELEVANT_TEXT = /zcash|ironwood/i;

// ---------------------------------------------------------------------------
// JSON5
// ---------------------------------------------------------------------------

/**
 * Strict JSON5 parser for Brave's study files: comments, single- or double-quoted strings,
 * unquoted keys, trailing commas, hex/signed numbers. Comment-like text inside strings is
 * preserved. Throws SyntaxError on anything that is not JSON5.
 */
export function parseJson5(src: string): unknown {
  let i = 0;
  const n = src.length;
  const fail = (msg: string): never => {
    const line = src.slice(0, i).split('\n').length;
    throw new SyntaxError(`JSON5: ${msg} at line ${line}`);
  };
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || c === ' ' || c === '﻿' || c === ' ' || c === ' ';
  const skip = () => {
    while (i < n) {
      const c = src[i];
      if (isWs(c)) i++;
      else if (c === '/' && src[i + 1] === '/') {
        i += 2;
        while (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== ' ' && src[i] !== ' ') i++;
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) fail('unterminated block comment');
        i = end + 2;
      } else return;
    }
  };
  const hex = (len: number): string => {
    const h = src.slice(i, i + len);
    if (h.length !== len || !/^[0-9a-fA-F]+$/.test(h)) fail('bad hex escape');
    i += len;
    return String.fromCharCode(parseInt(h, 16));
  };
  const str = (): string => {
    const q = src[i++];
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = src[i++];
      if (c === q) return out;
      if (c === '\n' || c === '\r') fail('unescaped line break in string');
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = src[i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0':
          if (/[0-9]/.test(src[i] ?? '')) fail('octal escape');
          out += '\0';
          break;
        case 'x': out += hex(2); break;
        case 'u': out += hex(4); break;
        case '\r':
          if (src[i] === '\n') i++;
          break; // line continuation
        case '\n':
        case ' ':
        case ' ':
          break; // line continuation
        case undefined:
          fail('unterminated string');
          break;
        default:
          if (/[1-9]/.test(e)) fail('octal escape');
          out += e; // \' \" \\ \/ and identity escapes
      }
    }
  };
  const IDENT = /[A-Za-z_$][\w$]*/y;
  const NUM = /[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const ident = (): string | null => {
    IDENT.lastIndex = i;
    const m = IDENT.exec(src);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const set = (obj: Record<string, unknown>, key: string, value: unknown) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  const value = (depth: number): unknown => {
    if (depth > 200) fail('nesting too deep');
    skip();
    const c = src[i];
    if (c === undefined) fail('unexpected end of input');
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        const key = src[i] === '"' || src[i] === "'" ? str() : ident();
        if (key === null) fail('expected a property name');
        skip();
        if (src[i] !== ':') fail("expected ':'");
        i++;
        set(obj, key as string, value(depth + 1));
        skip();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') fail("expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skip();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value(depth + 1));
        skip();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail("expected ',' or ']'");
      }
    }
    if (c === '"' || c === "'") return str();
    NUM.lastIndex = i;
    const num = NUM.exec(src);
    if (num) {
      i += num[0].length;
      const t = num[0];
      const sign = t.startsWith('-') ? -1 : 1;
      const body = t.replace(/^[+-]/, '');
      if (body === 'Infinity') return sign * Infinity;
      if (body === 'NaN') return NaN;
      if (/^0[xX]/.test(body)) return sign * parseInt(body.slice(2), 16);
      return sign * Number(body);
    }
    const word = ident();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return fail(`unexpected ${word ? `identifier '${word}'` : `character '${c}'`}`);
  };
  const out = value(0);
  skip();
  if (i < n) fail('unexpected trailing content');
  return out;
}

/** Kept for compatibility: parses JSON5 (see parseJson5). */
export function json5ToJson(src: string): unknown {
  return parseJson5(src);
}

// ---------------------------------------------------------------------------
// gate3 SWAP_DISABLED_CHAINS
// ---------------------------------------------------------------------------

interface PyStatement {
  code: string;
  line: number;
  indent: number;
  /** Contents of the string literals in this statement (replaced by '' in `code`). */
  strings: string[];
  /** Contents of the f-string literals among them: their {…} parts are code that runs. */
  fstrings?: string[];
}

/**
 * Split Python source into logical statements: comments dropped, string literals replaced by '',
 * bracketed and backslash-continued lines joined. Enough structure to read a module-level constant.
 */
export function pythonStatements(src: string): PyStatement[] {
  const out: PyStatement[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  let buf = '';
  let startLine = 1;
  let indent = 0;
  let strings: string[] = [];
  let fstrings: string[] = [];
  const flush = () => {
    if (buf.trim()) out.push({ code: buf.trim(), line: startLine, indent, strings, ...(fstrings.length ? { fstrings } : {}) });
    buf = '';
    strings = [];
    fstrings = [];
  };
  const begin = (at: number) => {
    if (buf.trim() === '') {
      startLine = line;
      indent = at - lineStart;
    }
  };
  const STR = /([rRuUbBfF]{0,2})('''|"""|'|")/y;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\r' ? 3 : 2;
      line++;
      lineStart = i;
      buf += ' ';
      continue;
    }
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      if (depth === 0) flush();
      else buf += ' ';
      continue;
    }
    const prevChar = i > 0 ? src[i - 1] : '';
    if (!/[\w]/.test(prevChar)) {
      STR.lastIndex = i;
      const m = STR.exec(src);
      if (m) {
        begin(i);
        const q = m[2];
        i += m[0].length;
        const contentStart = i;
        let contentEnd = n;
        for (;;) {
          if (i >= n) break;
          const ch = src[i];
          if (ch === '\\') {
            if (src[i + 1] === '\n') {
              line++;
              lineStart = i + 2;
            }
            i += 2;
            continue;
          }
          if (q.length === 3 ? src.startsWith(q, i) : ch === q) {
            contentEnd = i;
            i += q.length;
            break;
          }
          if (ch === '\n') {
            if (q.length === 1) {
              contentEnd = i;
              break; // unterminated single-line string: stop at the line end
            }
            line++;
            lineStart = i + 1;
          }
          i++;
        }
        const content = src.slice(contentStart, Math.min(contentEnd, n));
        strings.push(content);
        if (/f/i.test(m[1])) fstrings.push(content);
        buf += "''";
        continue;
      }
    }
    if (c === ';' && depth === 0) {
      flush();
      i++;
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '\r') begin(i);
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    buf += c;
    i++;
  }
  flush();
  return out;
}

function matchingClose(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return k;
    }
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Elements of a literal tuple/list/set (optionally wrapped in frozenset()/set()/tuple()/list()); null when the expression is not such a literal. */
function collectionElements(expr: string): string[] | null {
  let e = expr.trim();
  const call = /^(frozenset|set|tuple|list)\s*\(/.exec(e);
  if (call) {
    const open = call[0].length - 1;
    if (matchingClose(e, open) !== e.length - 1) return null;
    const inner = e.slice(open + 1, -1).trim();
    if (!inner) return [];
    e = inner;
    if (!/^[([{]/.test(e)) return null; // e.g. frozenset(OTHER_NAME)
  }
  if (/^[([{]/.test(e)) {
    if (matchingClose(e, 0) !== e.length - 1) return null;
    const inner = e.slice(1, -1);
    if (e[0] === '{' && splitTopLevel(inner, ':').length > 1) return null; // dict
    return splitTopLevel(inner, ',').map((x) => x.trim()).filter(Boolean);
  }
  const parts = splitTopLevel(e, ',');
  return parts.length > 1 ? parts.map((x) => x.trim()).filter(Boolean) : null; // bare tuple "Chain.A, Chain.B"
}

const SWAP_VAR = 'SWAP_DISABLED_CHAINS';
/** Methods that only read a tuple/list/set; any other method call on the switch may modify it. */
const READ_ONLY_METHODS = new Set(['union', 'intersection', 'difference', 'symmetric_difference', 'issubset', 'issuperset', 'isdisjoint', 'copy', 'count', 'index']);
const STAR_IMPORT = /^from\s+\S+\s+import\s+\*/;
/**
 * Namespace primitives that can create or rebind module names at run time without naming them in code
 * (globals()/vars()/locals(), sys.modules, __dict__, setattr/delattr, exec/eval). Any use makes the final value of a
 * module constant undeterminable by reading the file: the name can be in a string, a variable or an alias.
 */
const DYNAMIC_NAMESPACE = /(?<![\w.])(?:globals|vars|locals|setattr|delattr|exec|eval)\s*\(|\b__dict__\b|\b__(?:set|del)attr__\b|\bsys\s*\.\s*modules\b/;

interface PyToken {
  t: string;
  kind: 'name' | 'number' | 'string' | 'op';
  /** Bracket depth the token is at (an opening bracket is at the outer depth, its contents one deeper). */
  depth: number;
}
const PY_OPS = ['**=', '//=', '>>=', '<<=', '...', '->', ':=', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '**', '//', '<<', '>>'];
/** Assignment operators: a name to their left (at bracket depth 0) is an assignment target. */
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@=']);
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
/** Keywords whose following target list binds names: `for X in`, `... as X`, `del X`, `global X`, `import X`, `def X`, `class X`. */
const BINDING_KEYWORDS = new Set(['for', 'as', 'del', 'global', 'nonlocal', 'import', 'def', 'class']);

/** Tokens of one logical statement from pythonStatements (string literals are already ''). */
function pyTokens(code: string): PyToken[] {
  const out: PyToken[] = [];
  const NAME = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
  const NUMBER = /(?:\d|\.\d)[\w.]*/y;
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (code.startsWith("''", i)) {
      out.push({ t: "''", kind: 'string', depth });
      i += 2;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(code);
    if (name) {
      out.push({ t: name[0], kind: 'name', depth });
      i += name[0].length;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(code);
    if (num) {
      out.push({ t: num[0], kind: 'number', depth });
      i += num[0].length;
      continue;
    }
    const op = PY_OPS.find((o) => code.startsWith(o, i)) ?? c;
    if (op === ')' || op === ']' || op === '}') depth = Math.max(0, depth - 1);
    out.push({ t: op, kind: 'op', depth });
    if (op === '(' || op === '[' || op === '{') depth++;
    i += op.length;
  }
  return out;
}

/**
 * How a statement other than the definition binds or modifies the switch, or null when it only reads it.
 * The name is a target when it stands left of an assignment operator at bracket depth 0 (plain, chained, augmented,
 * annotated, tuple/list/starred, subscript and attribute targets, `type X = ...`, one-line `if c: X = ...`), when
 * it is assigned with := or passed as a keyword (`globals().update(X=...)`), when it is in the target list of
 * for/as/del/global/nonlocal/import/def/class or in a match-case pattern, or when a method that may modify it is
 * called on it.
 */
function switchBinding(code: string, expression = false): string | null {
  const toks = pyTokens(code);
  const hits = toks.flatMap((x, k) => (x.kind === 'name' && x.t === SWAP_VAR ? [k] : []));
  if (!hits.length) return null;
  // An f-string replacement field is an expression: "{X=}" is the debug form of a read, not an assignment.
  if (!expression) {
    let lastAssign = -1;
    toks.forEach((x, k) => {
      if (x.depth === 0 && x.kind === 'op' && ASSIGN_OPS.has(x.t)) lastAssign = k;
    });
    if (hits.some((k) => k < lastAssign)) return 'assignment target';
    const first = toks[0];
    if (first?.t === 'case' && toks[1] && !(toks[1].kind === 'op' && (ASSIGN_OPS.has(toks[1].t) || toks[1].t === '.'))) return 'match-case pattern';
  }
  for (const k of hits) {
    const next = toks[k + 1];
    if (next?.t === ':=') return 'assignment expression (:=)';
    if (next?.t === '=' && toks[k].depth > 0) return 'keyword argument (e.g. globals().update(...))';
    if (next?.t === '.' && toks[k + 2]?.kind === 'name' && toks[k + 3]?.t === '(' && !READ_ONLY_METHODS.has(toks[k + 2].t)) return `method call .${toks[k + 2].t}() that may modify it`;
    // Walk back over a target list ("for a, (b, X) in", "import a, X", "with f() as X") to its keyword.
    for (let j = k - 1; j >= 0; j--) {
      const p = toks[j];
      if (p.kind === 'name' && BINDING_KEYWORDS.has(p.t)) return `${p.t} target`;
      if (p.kind === 'name' && !PY_KEYWORDS.has(p.t)) continue;
      if (p.t === ',' || p.t === '*' || p.t === '.') continue;
      if (p.t === '(' || p.t === '[') {
        const before = toks[j - 1];
        // A call or subscript ("f(X)", "a[X]") is a read, not a target list.
        if (before && ((before.kind === 'name' && !PY_KEYWORDS.has(before.t)) || before.t === ')' || before.t === ']' || before.kind === 'string')) break;
        continue;
      }
      break;
    }
  }
  return null;
}

/** The replacement fields ("{...}", not "{{") of an f-string's contents: code that runs when the string is built. */
function fstringFields(content: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (content.startsWith('{{', i) || content.startsWith('}}', i)) {
      i += 2;
      continue;
    }
    if (content[i] !== '{') {
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    for (; j < content.length && depth > 0; j++) {
      if ('([{'.includes(content[j])) depth++;
      else if (')]}'.includes(content[j])) depth--;
    }
    out.push(content.slice(i + 1, depth === 0 ? j - 1 : j));
    i = j;
  }
  return out;
}

/** Code of a statement that string blanking hides: the replacement fields of its f-strings. */
const fstringCode = (s: PyStatement) => (s.fstrings ?? []).flatMap(fstringFields);

/**
 * Whether gate3's module-level SWAP_DISABLED_CHAINS contains Chain.ZCASH.
 * true/false only for a single top-level literal assignment whose relevant elements are all Chain.X and that no
 * other statement binds or modifies; null (unknown) for anything else: computed values, any other binding of the
 * name (see switchBinding, also inside f-string replacement fields), conditional definitions, a later star import,
 * or run-time namespace changes anywhere in the module (an alias such as `g = globals()` can hide the name, so any
 * use of those primitives leaves the value unknown).
 */
export function parseGate3Switch(src: string): { zcashDisabled: boolean | null; line: number | null; reason: string | null } {
  const stmts = pythonStatements(src);
  const assign = new RegExp(`^${SWAP_VAR}\\s*(?::[^=]+)?=(?!=)([\\s\\S]*)$`);
  const defs = stmts.filter((s) => assign.test(s.code));
  if (!defs.length) {
    const bound = stmts.find((s) => switchBinding(s.code));
    return { zcashDisabled: null, line: bound?.line ?? null, reason: bound ? `${SWAP_VAR} is bound only in a form other than a single literal assignment (${switchBinding(bound.code)})` : `${SWAP_VAR} assignment not found` };
  }
  const top = defs.filter((d) => d.indent === 0);
  if (!top.length) return { zcashDisabled: null, line: defs[0].line, reason: `${SWAP_VAR} is only assigned inside a block (conditional or nested definition)` };
  const def = top[0];
  const dynamic = stmts.find((s) => [s.code, ...fstringCode(s)].some((c) => DYNAMIC_NAMESPACE.test(c)));
  if (dynamic) return { zcashDisabled: null, line: def.line, reason: `the module changes names at run time (line ${dynamic.line}: globals()/vars()/setattr/exec or similar); the final value of ${SWAP_VAR} is not determined statically` };
  const others = stmts.filter(
    (s) =>
      s !== def &&
      (defs.includes(s) || switchBinding(s.code) !== null || fstringCode(s).some((c) => switchBinding(c, true) !== null) || (STAR_IMPORT.test(s.code) && s.line > def.line)),
  );
  if (others.length) {
    const at = others.map((s) => s.line);
    return { zcashDisabled: null, line: def.line, reason: `${SWAP_VAR} is assigned, imported or modified more than once (line${at.length === 1 ? '' : 's'} ${at.join(', ')}); its final value is not determined statically` };
  }
  const rhs = assign.exec(def.code)![1];
  // The value itself must be a plain literal: no chained target, walrus or self-reference.
  const rhsToks = pyTokens(rhs);
  if (rhsToks.some((x) => (x.kind === 'name' && x.t === SWAP_VAR) || x.t === ':=' || (x.depth === 0 && x.kind === 'op' && ASSIGN_OPS.has(x.t)))) {
    return { zcashDisabled: null, line: def.line, reason: `${SWAP_VAR} is not a literal tuple/list/set of Chain members` };
  }
  const elements = collectionElements(rhs);
  if (elements === null) return { zcashDisabled: null, line: def.line, reason: `${SWAP_VAR} is not a literal tuple/list/set of Chain members` };
  const names = elements.map((el) => /^Chain\s*\.\s*([A-Za-z_]\w*)$/.exec(el)?.[1] ?? null);
  if (names.some((x) => x !== null && x.toUpperCase() === 'ZCASH')) return { zcashDisabled: true, line: def.line, reason: null };
  if (names.some((x) => x === null)) return { zcashDisabled: null, line: def.line, reason: `${SWAP_VAR} contains elements other than Chain members` };
  return { zcashDisabled: false, line: def.line, reason: null };
}

// ---------------------------------------------------------------------------
// Studies
// ---------------------------------------------------------------------------

/** "139.1.81.129" / "152.*" style range check against a full version like "155.1.97.56". */
export function inStudyRange(full: string, min: string | null, max: string | null): boolean {
  const norm = (v: string, wildcard: string) => v.replace(/\*/g, wildcard);
  if (min && compareVersions(full, norm(min, '0')) < 0) return false;
  if (max && compareVersions(full, norm(max, '99999')) > 0) return false;
  return true;
}

/** One current build to evaluate study filters against. */
export interface StudyBuild {
  platform: Platform;
  channel: Channel;
  version: string;
  /** Chromium major version of this build, from the GitHub release name; null when unknown. */
  chromiumMajor: number | null;
  label: string;
  /** Desktop only: the versions.brave.com OS pointer this build was read from ("windows-x64"); absent for an aggregate desktop build. */
  os?: string;
}

const PLATFORM_NAME: Record<Platform, string> = { desktop: 'Desktop', android: 'Android', ios: 'iOS' };
const DESKTOP_FAMILIES = ['WINDOWS', 'MAC', 'LINUX'];
const FAMILY_NAME: Record<string, string> = { WINDOWS: 'Windows', MAC: 'macOS', LINUX: 'Linux' };
/** versions.brave.com desktop OS pointer suffixes, in display order. */
const DESKTOP_OS = ['windows-x64', 'windows-x86', 'windows-arm64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
const osFamily = (os: string): string | null => (os.startsWith('windows') ? 'WINDOWS' : os.startsWith('macos') ? 'MAC' : os.startsWith('linux') ? 'LINUX' : null);
const osName = (os: string) => `${FAMILY_NAME[osFamily(os) ?? ''] ?? os} ${os.split('-').slice(1).join('-')}`;
const PLATFORM_CODES: Record<Platform, string[]> = { desktop: DESKTOP_FAMILIES, android: ['ANDROID'], ios: ['IOS'] };
const CHANNEL_CODES: Record<Channel, string[]> = { release: ['RELEASE', 'STABLE'], beta: ['BETA'], nightly: ['NIGHTLY', 'CANARY'] };
/** Filter keys evaluated against build records. */
const BUILD_KEYS = new Set(['platform', 'channel', 'min_version', 'max_version', 'start_date', 'end_date']);
/** Filter keys that restrict which clients of an eligible build enrol; public data cannot decide them. */
const CLIENT_KEYS = new Set([
  'locale', 'exclude_locale', 'country', 'exclude_country', 'form_factor', 'exclude_form_factor',
  'hardware_class', 'exclude_hardware_class', 'min_os_version', 'max_os_version', 'os_version',
  'is_low_end_device', 'policy_restriction', 'is_enterprise', 'google_group', 'exclude_google_group',
  'cpu_architecture', 'exclude_cpu_architecture',
]);
const BUILD_VERSION_RE = /^\d+\.\d+\.\d+$/;

const normCode = (v: unknown) => String(v).toUpperCase().replace(/^(PLATFORM|CHANNEL)_/, '');
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === null ? [] : [String(v)]);
const uniqStr = (xs: string[]) => [...new Set(xs)];

function dateValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000; // Chromium: seconds since epoch
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return Number(v) * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * One clause of a filter outcome. Clauses with the same `key` say the same thing about different builds, so the
 * per-OS desktop builds of one channel can be summarised clause by clause instead of repeating every OS's reason.
 */
export interface FilterClause {
  key: string;
  /** platform: `key` + the excluded build; version: `full` + `key`; others: `text` is the same for every build with this key. */
  kind: (typeof CLAUSE_ORDER)[number];
  /** As stated for this one build. */
  text: string;
  /** version clauses: the full (Chromium-based) version that was compared. */
  full?: string;
}
/** Clause kinds in the order a filter is evaluated (and reasons are written). */
const CLAUSE_ORDER = ['platform', 'channel', 'version', 'version-unknown', 'date', 'key'] as const;

/** Evaluate a study filter against one build. null = cannot be determined from public data. */
export function evaluateStudyFilter(
  filter: Record<string, unknown> | null | undefined,
  b: StudyBuild,
  now: string,
): { applies: boolean | null; reason: string; desktopOs?: string[]; clauses: FilterClause[] } {
  const f = filter ?? {};
  const excluded: FilterClause[] = [];
  const unknown: FilterClause[] = [];
  const other = (kind: FilterClause['kind'], text: string): FilterClause => ({ key: text, kind, text });
  let desktopOs: string[] | undefined;

  const platforms = asList(f.platform).map(normCode);
  if (platforms.length) {
    // A per-OS desktop build is one OS family; an aggregate desktop build stands for all three.
    const family = b.platform === 'desktop' && b.os ? osFamily(b.os) : null;
    const codes = family ? [family] : PLATFORM_CODES[b.platform];
    const hit = codes.filter((p) => platforms.includes(p));
    const key = `platform filter (${platforms.join(', ')}) excludes`;
    if (!hit.length) excluded.push({ key, kind: 'platform', text: `${key} ${b.os ? `${PLATFORM_NAME.desktop} ${osName(b.os)}` : PLATFORM_NAME[b.platform]}` });
    else if (b.platform === 'desktop' && !family && hit.length < DESKTOP_FAMILIES.length) desktopOs = hit;
  }
  const channels = asList(f.channel).map(normCode);
  if (channels.length && !CHANNEL_CODES[b.channel].some((c) => channels.includes(c))) excluded.push(other('channel', `channel filter (${channels.join(', ')}) excludes ${b.channel}`));

  const min = f.min_version === undefined || f.min_version === null ? null : String(f.min_version);
  const max = f.max_version === undefined || f.max_version === null ? null : String(f.max_version);
  if (min || max) {
    const range = `${min ?? 'any'} – ${max ?? 'any'}`;
    if (b.chromiumMajor === null || !BUILD_VERSION_RE.test(b.version)) unknown.push(other('version-unknown', `the Chromium-based version of ${b.version} is not known, so the version range ${range} cannot be checked`));
    else {
      const full = `${b.chromiumMajor}.${b.version}`;
      const key = `outside the version range ${range}`;
      if (!inStudyRange(full, min, max)) excluded.push({ key, kind: 'version', text: `${full} is ${key}`, full });
    }
  }
  const nowMs = Date.parse(now);
  for (const [key, cmp] of [['start_date', 1], ['end_date', -1]] as const) {
    if (f[key] === undefined || f[key] === null) continue;
    const t = dateValue(f[key]);
    if (t === null || !Number.isFinite(nowMs)) unknown.push(other('date', `${key} ${String(f[key])} could not be interpreted`));
    else if (cmp === 1 ? nowMs < t : nowMs > t) excluded.push(other('date', `${key} ${new Date(t).toISOString()} ${cmp === 1 ? 'is in the future' : 'has passed'}`));
  }
  for (const key of Object.keys(f)) {
    if (BUILD_KEYS.has(key) || CLIENT_KEYS.has(key)) continue;
    unknown.push(other('key', `filter key "${key}" is not evaluated`));
  }
  const join = (cs: FilterClause[]) => cs.map((c) => c.text).join('; ');
  if (excluded.length) return { applies: false, reason: join(excluded), clauses: excluded };
  if (unknown.length) return { applies: null, reason: join(unknown), clauses: unknown };
  return { applies: true, reason: desktopOs ? `admitted on ${desktopOs.join(', ')} only among desktop OSes` : 'platform, channel and version filters admit this build', ...(desktopOs ? { desktopOs } : {}), clauses: [] };
}

/**
 * One reason for the per-OS desktop builds of a channel that share an outcome: each clause once, naming the OSes it
 * concerns only when it does not concern every build of the group ("platform filter (IOS) excludes Desktop (all 7 OS
 * builds); channel filter (NIGHTLY, BETA) excludes release; 155.1.97.56 is outside the version range 146.1.89.116 – 152.*").
 */
function desktopGroupReason(results: { b: StudyBuild; r: ReturnType<typeof evaluateStudyFilter> }[], channelOs: string[]): string {
  if (results.every((x) => !x.r.clauses.length)) return uniqStr(results.map((x) => x.r.reason)).join('; ');
  const groupOs = results.map((x) => x.b.os!);
  const covers = (os: string[], all: string[]) => all.every((o) => os.includes(o));
  const where = (os: string[]) => describeOs(os, channelOs);
  const merged = new Map<string, { c: FilterClause; os: string[]; versions: Map<string, string[]> }>();
  for (const { b, r } of results) {
    for (const c of r.clauses) {
      const e = merged.get(c.key) ?? { c, os: [], versions: new Map<string, string[]>() };
      merged.set(c.key, e);
      e.os.push(b.os!);
      if (c.full) e.versions.set(c.full, [...(e.versions.get(c.full) ?? []), b.os!]);
    }
  }
  const out: string[] = [];
  const rank = (c: FilterClause) => CLAUSE_ORDER.indexOf(c.kind);
  for (const { c, os, versions } of [...merged.values()].sort((p, q) => rank(p.c) - rank(q.c))) {
    if (c.kind === 'platform') out.push(`${c.key} ${PLATFORM_NAME.desktop}${covers(os, channelOs) && channelOs.length > 1 ? ` (all ${channelOs.length} OS builds)` : ` ${where(os)}`}`);
    else if (c.kind === 'version' && versions.size > 1) {
      const list = [...versions].sort((p, q) => compareVersions(q[0], p[0])).map(([v, vos]) => `${v} (${where(vos)})`);
      out.push(`${list.join(' and ')} are ${c.key}`);
    } else out.push(covers(os, groupOs) ? c.text : `${c.text} (${where(os)})`);
  }
  return out.join('; ');
}

/** Client-level conditions of a filter, as readable strings. */
export function studyConditions(filter: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(filter ?? {})
    .filter(([k]) => CLIENT_KEYS.has(k))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
}

const versionLabel = (version: string, major: number | null) => `${version}${major !== null && BUILD_VERSION_RE.test(version) ? ` (${major}.${version})` : ''}`;

/**
 * Current builds per platform × channel: versions.brave.com pointers, GitHub release names as a labelled fallback.
 * Desktop is one build per OS pointer when the per-OS values are known (OS builds can differ, e.g. Linux behind
 * Windows), so a study filter is evaluated against each OS's own version.
 */
export function studyBuilds(versions: ChannelVersion[] | null, rel: ReleasesData | null): StudyBuild[] {
  const releases = Array.isArray(rel?.releases) ? rel!.releases : [];
  const chromiumOf = (version: string): number | null => {
    const r = releases.find((x) => x.version === version);
    const major = r?.chromium ? Number(r.chromium.split('.')[0]) : NaN;
    return Number.isFinite(major) ? major : null;
  };
  const out: StudyBuild[] = [];
  const latest = Array.isArray(rel?.latest) ? rel!.latest : [];
  for (const channel of ['release', 'beta', 'nightly'] as Channel[]) {
    for (const platform of ['desktop', 'android', 'ios'] as Platform[]) {
      const cv = (versions ?? []).find((c) => c.channel === channel && c.platform === platform);
      if (platform === 'desktop' && cv?.detail) {
        const notPublished = new Set(cv.notPublishedPointers ?? []);
        const known = DESKTOP_OS.map((os) => [os, cv.detail![`${channel}-${os}`]] as const).filter((e): e is readonly [string, string] => typeof e[1] === 'string' && BUILD_VERSION_RE.test(e[1]));
        const usable = known.filter(([os]) => !notPublished.has(`${channel}-${os}`));
        const list = usable.length ? usable : known;
        if (list.length) {
          for (const [os, version] of list) {
            const major = chromiumOf(version);
            out.push({ platform, channel, version, chromiumMajor: major, os, label: `${PLATFORM_NAME.desktop} ${channel} (${osName(os)}) ${versionLabel(version, major)}` });
          }
          continue;
        }
      }
      let version: string | null = cv?.version ?? null;
      let fallback = false;
      if (!version) {
        if (platform === 'ios' && channel === 'release') continue; // App Store build is not published; no fallback
        version = latest.find((l) => l.channel === channel)?.version ?? null;
        fallback = Boolean(version);
      }
      if (!version) continue;
      const major = chromiumOf(version);
      out.push({ platform, channel, version, chromiumMajor: major, label: `${PLATFORM_NAME[platform]} ${channel} ${versionLabel(version, major)}${fallback ? ' [GitHub release; version pointer unavailable]' : ''}` });
    }
  }
  return out;
}

/** "Windows" when every Windows pointer is in the group, else "Windows arm64"; families in display order. */
function describeOs(group: string[], all: string[]): string {
  const parts: string[] = [];
  for (const fam of DESKTOP_FAMILIES) {
    const famAll = all.filter((os) => osFamily(os) === fam);
    const famIn = famAll.filter((os) => group.includes(os));
    if (!famIn.length) continue;
    parts.push(famIn.length === famAll.length ? FAMILY_NAME[fam] : famIn.map(osName).join(', '));
  }
  return parts.join(', ');
}

function applicability(filter: Record<string, unknown> | undefined, builds: StudyBuild[], now: string, note = ''): Pick<StudyInfo, 'appliesTo' | 'appliesUnknown'> {
  const appliesTo: StudyApplicability[] = [];
  const appliesUnknown: NonNullable<StudyInfo['appliesUnknown']> = [];
  const desktopDone = new Set<Channel>();
  for (const b of builds) {
    if (b.platform === 'desktop' && b.os) {
      // Per-OS desktop builds of one channel: one entry per outcome, naming the OSes when not all share it.
      if (desktopDone.has(b.channel)) continue;
      desktopDone.add(b.channel);
      const same = builds.filter((x) => x.platform === 'desktop' && x.os && x.channel === b.channel);
      const results = same.map((x) => ({ b: x, r: evaluateStudyFilter(filter, x, now) }));
      for (const outcome of uniqStr(results.map((x) => String(x.r.applies)))) {
        const g = results.filter((x) => String(x.r.applies) === outcome);
        const sorted = g.map((x) => x.b).sort((p, q) => compareVersions(p.version, q.version));
        const versions = uniqStr(sorted.map((x) => versionLabel(x.version, x.chromiumMajor)));
        const osList = g.map((x) => x.b.os!);
        const all = g.length === same.length;
        const build = `${PLATFORM_NAME.desktop} ${b.channel}${all ? '' : ` (${describeOs(osList, same.map((x) => x.os!))})`} ${versions.join(' / ')}`;
        const reason = desktopGroupReason(g, same.map((x) => x.os!)) + note;
        if (outcome === 'null') appliesUnknown.push({ build, platform: 'desktop', channel: b.channel, version: sorted[0].version, reason });
        else appliesTo.push({ build, applies: outcome === 'true', platform: 'desktop', channel: b.channel, version: sorted[0].version, reason, ...(all ? {} : { desktopOs: osList }) });
      }
      continue;
    }
    const r = evaluateStudyFilter(filter, b, now);
    if (r.applies === null) appliesUnknown.push({ build: b.label, platform: b.platform, channel: b.channel, version: b.version, reason: r.reason + note });
    else appliesTo.push({ build: b.label, applies: r.applies, platform: b.platform, channel: b.channel, version: b.version, reason: r.reason + note, ...(r.desktopOs ? { desktopOs: r.desktopOs } : {}) });
  }
  return appliesUnknown.length ? { appliesTo, appliesUnknown } : { appliesTo };
}

/** Filter fields kept by data written before the raw filter was stored (version range, channels, platforms). */
function legacyFilter(st: StudyInfo): Record<string, unknown> {
  return {
    ...(st.minVersion ? { min_version: st.minVersion } : {}),
    ...(st.maxVersion ? { max_version: st.maxVersion } : {}),
    ...(Array.isArray(st.channels) && st.channels.length ? { channel: st.channels } : {}),
    ...(Array.isArray(st.platforms) && st.platforms.length ? { platform: st.platforms } : {}),
  };
}

/** Recompute applicability of a stored study for the current builds (keeps the old answer when there are no builds). */
function refreshApplicability(st: StudyInfo, builds: StudyBuild[], now: string): StudyInfo {
  if (!builds.length) return st;
  const { appliesUnknown: _stale, ...rest } = st;
  // Data from before the raw filter was stored: rebuild it from the stored fields and say so.
  const res = st.filter ? applicability(st.filter, builds, now) : applicability(legacyFilter(st), builds, now, ' (filter reconstructed from the stored version, channel and platform fields)');
  return { ...rest, ...res };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).map(String) : typeof v === 'string' ? [v] : []);

/**
 * Whether a parsed study touches Zcash: some experiment enables, disables or forces a Zcash/Ironwood feature, or
 * sets a parameter whose name or value names Zcash/Ironwood. Other wallet features do not count.
 */
export function isRelevantStudy(st: any): boolean {
  if (!st || typeof st !== 'object') return false;
  for (const e of Array.isArray(st.experiment) ? st.experiment : []) {
    const fa = e?.feature_association ?? {};
    const terms = [...strList(fa.enable_feature), ...strList(fa.disable_feature), ...strList(fa.forcing_feature_on), ...strList(fa.forcing_feature_off)];
    for (const p of Array.isArray(e?.param) ? e.param : []) terms.push(String(p?.name ?? ''), String(p?.value ?? ''));
    if (terms.some((x) => RELEVANT_TEXT.test(x))) return true;
  }
  return false;
}

/** The same test for a stored StudyInfo (cohorts when stored, else the study-level features/params of older data). */
export function studyInfoTouchesZcash(st: StudyInfo): boolean {
  const terms: string[] = [];
  for (const e of Array.isArray(st.experiments) ? st.experiments : []) {
    terms.push(...strList(e.enable), ...strList(e.disable), ...strList(e.forcingOn), ...strList(e.forcingOff));
    for (const [k, v] of Object.entries(e.params ?? {})) terms.push(k, String(v));
  }
  terms.push(...strList(st.features?.enable), ...strList(st.features?.disable));
  for (const [k, v] of Object.entries(st.params ?? {})) terms.push(k, String(v));
  return terms.some((x) => RELEVANT_TEXT.test(x));
}

/** Turn one parsed study into StudyInfo, keeping each cohort separately. */
export function toStudyInfo(st: any, file: string, commit: string, builds: StudyBuild[], now: string): StudyInfo {
  const exps: any[] = Array.isArray(st.experiment) ? st.experiment : [];
  const total = exps.reduce((s, e) => s + (Number(e?.probability_weight) || 0), 0);
  const experiments: StudyExperiment[] = exps.map((e) => {
    const weight = Number(e?.probability_weight) || 0;
    const params: Record<string, string> = {};
    for (const p of Array.isArray(e?.param) ? e.param : []) if (p?.name !== undefined) params[String(p.name)] = String(p.value ?? '');
    const fa = e?.feature_association ?? {};
    const forcingOn = strList(fa.forcing_feature_on);
    const forcingOff = strList(fa.forcing_feature_off);
    return {
      name: String(e?.name ?? ''),
      weight,
      share: total > 0 ? Math.round((weight / total) * 10000) / 100 : null,
      enable: strList(fa.enable_feature),
      disable: strList(fa.disable_feature),
      params,
      ...(forcingOn.length ? { forcingOn } : {}),
      ...(forcingOff.length ? { forcingOff } : {}),
    };
  });
  const active = experiments.filter((e) => e.weight > 0);
  // A feature is listed as enabled (disabled) when some enrolled cohort enables (disables) it and no enrolled
  // cohort sets the opposite; a parameter keeps its value when every cohort that sets it agrees. Anything that
  // differs between enrolled cohorts (including set vs. not set) is listed in `mixed`.
  const setting = (e: StudyExperiment, f: string) => (e.enable.includes(f) && e.disable.includes(f) ? 'conflict' : e.enable.includes(f) ? 'on' : e.disable.includes(f) ? 'off' : 'default');
  const allFeatures = uniqStr(active.flatMap((e) => [...e.enable, ...e.disable]));
  const enable: string[] = [];
  const disable: string[] = [];
  const mixedFeatures: string[] = [];
  for (const f of allFeatures) {
    const s = active.map((e) => setting(e, f));
    if (!s.includes('off') && !s.includes('conflict') && s.includes('on')) enable.push(f);
    if (!s.includes('on') && !s.includes('conflict') && s.includes('off')) disable.push(f);
    if (uniqStr(s).length > 1 || s.includes('conflict')) mixedFeatures.push(f);
  }
  const params: Record<string, string> = {};
  const mixedParams: string[] = [];
  for (const name of uniqStr(active.flatMap((e) => Object.keys(e.params)))) {
    const values = active.map((e) => (Object.prototype.hasOwnProperty.call(e.params, name) ? e.params[name] : undefined));
    const set = uniqStr(values.filter((v): v is string => v !== undefined));
    if (set.length === 1) params[name] = set[0];
    if (set.length > 1 || values.some((v) => v === undefined)) mixedParams.push(name);
  }
  const filter: Record<string, unknown> = st.filter && typeof st.filter === 'object' && !Array.isArray(st.filter) ? st.filter : {};
  const conditions = studyConditions(filter);
  return {
    file,
    name: String(st.name ?? ''),
    features: { enable, disable },
    params,
    minVersion: filter.min_version === undefined || filter.min_version === null ? null : String(filter.min_version),
    maxVersion: filter.max_version === undefined || filter.max_version === null ? null : String(filter.max_version),
    channels: strList(filter.channel),
    platforms: strList(filter.platform),
    probability: active.reduce((n, e) => n + e.weight, 0) || null,
    ...applicability(filter, builds, now),
    url: `https://github.com/brave/brave-variations/blob/${commit}/studies/${encodeURIComponent(file)}`,
    experiments,
    ...(mixedFeatures.length || mixedParams.length ? { mixed: { features: mixedFeatures, params: mixedParams } } : {}),
    ...(conditions.length ? { conditions } : {}),
    filter,
    readAt: now,
  };
}

/** Git blob SHA-1 of a file's bytes, as the GitHub contents API lists it. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Digest of a studies/ listing (file names and blob SHAs) and the selection rules; null when a blob SHA is missing. */
export function listingDigest(files: { name: string; sha: string | null }[]): string | null {
  if (files.some((f) => !f.sha)) return null;
  const h = createHash('sha256').update(`rules=${STUDY_RULES}\n`);
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) h.update(`${f.name}\t${f.sha}\n`);
  return h.digest('hex');
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120);

export const services: Collector<ServicesData> = {
  id: 'brave-services',
  name: 'Brave server-side signals (gate3 swap routing, brave-variations studies)',
  url: 'https://github.com/brave/gate3',
  schema: 1,
  dependsOn: ['brave-releases', 'brave-versions'],
  budget: { 'github-core': 12 },
  async collect(ctx, prev) {
    const limitations: string[] = ['Repository state is shown; the deployed service could differ and its deployment time is not public'];
    let partial = false;
    // Read time of the previous data, for legacy records that do not carry their own.
    const ownPrev = ctx.get<ServicesData>('brave-services');
    const prevReadAt = ownPrev?.sourceId === 'brave-services' ? ownPrev.retrievedAt : null;

    // ---- gate3 swap routing ----
    let gate3: Gate3Info | null = prev?.gate3 ?? null;
    let gate3Fresh = false;
    try {
      const gsha = await ctx.gh.commitSha('brave/gate3', 'master');
      if (!gsha) throw new Error('master commit could not be resolved');
      const res = await ctx.http.request(`https://raw.githubusercontent.com/brave/gate3/${gsha}/${GATE3_FILE}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
      const text = await res.text();
      const parsed = res.status === 404 ? { zcashDisabled: null, line: null, reason: `${GATE3_FILE} not found (layout changed?)` } : parseGate3Switch(text);
      gate3Fresh = true;
      const old = prev?.gate3 ?? null;
      const lastDetermined =
        parsed.zcashDisabled !== null
          ? null
          : old && old.zcashDisabled !== null && old.commitSha
            ? { zcashDisabled: old.zcashDisabled, commitSha: old.commitSha, checkedAt: old.checkedAt, url: old.url, line: old.line }
            : (old?.lastDetermined ?? null);
      gate3 = {
        commitSha: gsha,
        file: GATE3_FILE,
        zcashDisabled: parsed.zcashDisabled,
        line: parsed.line,
        url: res.status === 404 ? `https://github.com/brave/gate3/tree/${gsha}` : `https://github.com/brave/gate3/blob/${gsha}/${GATE3_FILE}${parsed.line ? `#L${parsed.line}` : ''}`,
        checkedAt: ctx.now,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        ...(lastDetermined ? { lastDetermined } : {}),
      };
      if (parsed.zcashDisabled === null) {
        partial = true;
        limitations.push(`gate3 at ${gsha.slice(0, 8)}: ${parsed.reason}; Zcash routing state is unknown${lastDetermined ? ` (last determined ${lastDetermined.zcashDisabled ? 'disabled' : 'not disabled'} at ${lastDetermined.commitSha.slice(0, 8)}, ${lastDetermined.checkedAt})` : ''}`);
      }
    } catch (err) {
      partial = true;
      limitations.push(`brave/gate3 could not be re-read (${errText(err)}); ${gate3 ? `keeping the value read at ${gate3.checkedAt}` : 'no earlier value'}`);
    }

    // ---- brave-variations studies ----
    const versionsData = ctx.get<{ current?: ChannelVersion[] }>('brave-versions')?.data;
    const relData = ctx.get<ReleasesData>('brave-releases')?.data ?? null;
    const builds = studyBuilds(Array.isArray(versionsData?.current) ? versionsData!.current : null, relData);
    // Earlier data can hold studies selected by older, broader rules (e.g. any Brave Wallet feature); those never
    // touched Zcash and are not carried, even while brave-variations cannot be re-read.
    const prevAll = Array.isArray(prev?.studies) ? prev!.studies : [];
    const prevStudies = prevAll.filter(studyInfoTouchesZcash).map((s) => ({ ...s, readAt: s.readAt ?? prevReadAt }));
    const notZcash = uniqStr(prevAll.filter((s) => !studyInfoTouchesZcash(s)).map((s) => s.name));
    if (notZcash.length) limitations.push(`${notZcash.length} earlier stud${notZcash.length === 1 ? 'y was' : 'ies were'} dropped because no cohort sets a Zcash/Ironwood feature or parameter: ${notZcash.slice(0, 4).join(', ')}`);
    const prevByFile = new Map<string, StudyInfo[]>();
    for (const s of prevStudies) prevByFile.set(s.file, [...(prevByFile.get(s.file) ?? []), s]);
    const carry = (file: string) => (prevByFile.get(file) ?? []).map((s) => refreshApplicability(s, builds, ctx.now));

    let studies: StudyInfo[] = prevStudies.map((s) => refreshApplicability(s, builds, ctx.now));
    let studiesCommit = prev?.studiesCommit ?? null;
    let studiesReadAt = prev?.studiesReadAt ?? (prev ? prevReadAt : null);
    let studiesDigest = typeof prev?.studiesDigest === 'string' ? prev.studiesDigest : null;
    let studyPending: string[] = Array.isArray(prev?.studyPending) ? prev!.studyPending : [];
    let variationsFresh = false;
    try {
      const vsha = await ctx.gh.commitSha('brave/brave-variations', 'main');
      if (!vsha) throw new Error('main commit could not be resolved');
      const { data: listing } = await ctx.gh.rest<any[]>(`/repos/brave/brave-variations/contents/studies?ref=${vsha}`);
      if (!Array.isArray(listing)) throw new Error('studies/ listing is not a directory listing');
      variationsFresh = true;
      const entries = listing.filter((x) => x && typeof x.name === 'string');
      const dirs = entries.filter((x) => x.type === 'dir');
      // Only a well-formed blob SHA-1 can be verified against; anything else counts as "no SHA" (content must parse).
      const files: { name: string; sha: string | null }[] = entries
        .filter((x) => x.type !== 'dir' && /\.json5?$/i.test(x.name))
        .map((x) => ({ name: x.name as string, sha: typeof x.sha === 'string' && /^[0-9a-f]{40}$/i.test(x.sha) ? x.sha.toLowerCase() : null }));
      const other = entries.filter((x) => x.type !== 'dir' && !/\.json5?$/i.test(x.name));
      if (dirs.length) {
        partial = true;
        limitations.push(`studies/ contains ${dirs.length} subdirector${dirs.length === 1 ? 'y' : 'ies'} that were not scanned (${dirs.slice(0, 4).map((d) => d.name).join(', ')})`);
      }
      if (other.length) limitations.push(`${other.length} non-JSON5 file(s) in studies/ were not read (${other.slice(0, 4).map((d) => d.name).join(', ')})`);
      const truncatedListing = listing.length >= 1000;
      if (truncatedListing) {
        partial = true;
        limitations.push('studies/ listing returned 1000 entries (the contents API maximum); files beyond it were not read and their earlier studies are kept');
      }
      // Unchanged listing (same names and blob SHAs, same rules): only files still pending from earlier runs are read.
      const digest = truncatedListing ? null : listingDigest(files);
      const unchanged = digest !== null && digest === studiesDigest;
      const prevPending = new Set(studyPending);
      const next: StudyInfo[] = [];
      const pending: string[] = [];
      const failed: string[] = [];
      const deferred: string[] = [];
      const unparsedIrrelevant: string[] = [];
      let fetched = 0;
      for (const f of files) {
        const name = f.name;
        if (unchanged && !prevPending.has(name)) {
          next.push(...carry(name));
          continue;
        }
        // Keep the file's earlier studies and retry it next run.
        const keep = (problem: string | null) => {
          if (problem) failed.push(`${name} (${problem})`);
          pending.push(name);
          next.push(...carry(name));
        };
        if (fetched >= MAX_STUDY_FETCHES) {
          deferred.push(name);
          keep(null);
          continue;
        }
        fetched += 1;
        let bytes: Uint8Array;
        try {
          const raw = await ctx.http.request(`https://raw.githubusercontent.com/brave/brave-variations/${vsha}/studies/${encodeURIComponent(name)}`, { scope: 'raw.githubusercontent.com' });
          bytes = new Uint8Array(await raw.arrayBuffer());
        } catch (err) {
          keep(errText(err));
          continue;
        }
        // The listing's blob SHA identifies the exact file: a truncated, empty or substituted body is a failed read.
        if (f.sha && gitBlobSha(bytes) !== f.sha) {
          keep(`content does not match the listed blob ${f.sha.slice(0, 8)} (${bytes.length} bytes received)`);
          continue;
        }
        const text = new TextDecoder().decode(bytes);
        let parsed: unknown[] | null = null;
        let parseError = '';
        try {
          const p = parseJson5(text);
          if (!Array.isArray(p)) throw new Error('top level is not a list of studies');
          parsed = p;
        } catch (err) {
          parseError = errText(err);
        }
        if (!parsed) {
          // Verified file content that never mentions Zcash/Ironwood cannot hold a Zcash study, parseable or not.
          if (f.sha && !RELEVANT_TEXT.test(text)) unparsedIrrelevant.push(name);
          else keep(`could not parse: ${parseError}`);
          continue;
        }
        if (!RELEVANT_TEXT.test(text)) continue; // a valid study file that never mentions Zcash/Ironwood
        next.push(...parsed.filter(isRelevantStudy).map((st) => toStudyInfo(st, name, vsha, builds, ctx.now)));
      }
      if (truncatedListing) {
        const listed = new Set(files.map((f) => f.name));
        for (const [file] of prevByFile) if (!listed.has(file)) next.push(...carry(file));
      }
      if (failed.length) {
        partial = true;
        limitations.push(`${failed.length} study file(s) could not be read or parsed; their earlier studies are kept and they are retried next run: ${failed.slice(0, 4).join('; ')}`);
      }
      if (deferred.length) {
        partial = true;
        limitations.push(`${deferred.length} study file(s) deferred by the per-run cap of ${MAX_STUDY_FETCHES}; their earlier studies are kept`);
      }
      if (unparsedIrrelevant.length) limitations.push(`${unparsedIrrelevant.length} study file(s) could not be parsed but contain no Zcash/Ironwood wording (content verified against the listed blob SHA): ${unparsedIrrelevant.slice(0, 4).join(', ')}`);
      studies = next;
      studiesCommit = vsha;
      studiesReadAt = ctx.now;
      studiesDigest = digest;
      studyPending = pending;
    } catch (err) {
      partial = true;
      limitations.push(`brave/brave-variations could not be re-read (${errText(err)}); ${prevStudies.length ? `keeping ${prevStudies.length} stud${prevStudies.length === 1 ? 'y' : 'ies'} read at ${studiesReadAt ?? 'an earlier run'}` : 'no earlier studies to show'}`);
    }

    if (!gate3Fresh && !variationsFresh) throw new Error('neither brave/gate3 nor brave/brave-variations could be read');
    const unknownBuilds = studies.filter((s) => s.appliesUnknown?.length).length;
    if (unknownBuilds) limitations.push(`${unknownBuilds} stud${unknownBuilds === 1 ? 'y has' : 'ies have'} builds whose eligibility cannot be determined from public data`);
    const data: ServicesData = {
      gate3,
      studies,
      studiesCommit,
      studiesReadAt: studiesReadAt ?? null,
      ...(studiesDigest ? { studiesDigest } : {}),
      ...(studyPending.length ? { studyPending } : {}),
    };
    return { data, limitations, partial, itemCount: studies.length + (gate3 ? 1 : 0) };
  },
};

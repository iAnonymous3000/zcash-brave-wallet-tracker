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
  /** Columns before the statement on its line (statements after ';' share their line's indentation). */
  indent: number;
  /** Contents of the string literals in this statement (replaced by '' in `code`). */
  strings: string[];
  /** The prefix of each literal in `strings` as written ('', 'f', 'Rb', ...), in the same order. */
  prefixes: string[];
  /** Contents of the f-string and t-string literals among them: their {…} parts are code that runs. */
  fstrings?: string[];
  /** A string literal in this statement is not closed (a syntax error, or a form this scanner does not know). */
  unterminated?: boolean;
  /** The statement follows a ';' on its line. */
  afterSemicolon?: boolean;
  /** Why the source around this statement does not compile, or may not depending on the Python version. */
  error?: string;
}

/**
 * Python's whitespace between tokens: space, tab and form feed only. JavaScript's trim() and \s also remove U+000B,
 * U+00A0, U+FEFF, U+2028, U+3000 and others, which Python rejects outside strings and comments ("invalid non-printable
 * character"); those stay in the statement, so it reads as not compiling.
 */
const pyTrim = (s: string) => s.replace(/^[ \t\f]+|[ \t\f]+$/g, '');

/** Python string prefixes (any case): r, u, b, f, t and their two-letter combinations. */
const STRING_PREFIX = /^(?:[rubft]|br|rb|fr|rf|tr|rt)$/i;
const IDENTIFIER = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
/**
 * Keywords that open a compound statement. On the header's line, everything after the header's ':' is the one-line
 * suite, ';'-separated statements included: `def f(): pass; X = 1` binds X inside f, not in the module.
 */
const COMPOUND_HEADS = new Set(['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'async']);
/** Soft keywords that open a compound statement in some uses only (`match = 1` is an assignment). */
const SOFT_COMPOUND_HEADS = new Set(['match', 'case']);

/**
 * Split Python source into logical statements: comments dropped, string literals replaced by '',
 * bracketed and backslash-continued lines joined. Words are read whole, so a quote directly after a keyword
 * (`else"""…"""`) starts a string and a quote after a string prefix starts a prefixed string, as in Python's tokenizer.
 * A ';' ends a statement except on a compound statement's header line, where the rest of the line is the header's
 * one-line suite and stays part of that statement. Only space, tab and form feed count as whitespace: any other
 * character, a no-break space or a vertical tab on an otherwise blank line included, is part of a statement.
 */
export function pythonStatements(source: string): PyStatement[] {
  const src = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out: PyStatement[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  let buf = '';
  /** The current statement has begun (buf holds more than space, tab and form feed). */
  let started = false;
  let startLine = 1;
  let indent = 0;
  let afterSemicolon = false;
  let stmtAfterSemicolon = false;
  let strings: string[] = [];
  let prefixes: string[] = [];
  let fstrings: string[] = [];
  let unterminated = false;
  let error: string | undefined;
  /** The current statement starts with a compound keyword ('hard') or a soft one ('soft'). */
  let head: 'hard' | 'soft' | null = null;
  /** A ':' outside brackets has been seen in the current statement. */
  let colonSeen = false;
  const flush = () => {
    if (started) {
      out.push({
        code: pyTrim(buf),
        line: startLine,
        indent,
        strings,
        prefixes,
        ...(fstrings.length ? { fstrings } : {}),
        ...(unterminated ? { unterminated } : {}),
        ...(stmtAfterSemicolon ? { afterSemicolon: true } : {}),
        ...(error ? { error } : {}),
      });
    }
    buf = '';
    started = false;
    strings = [];
    prefixes = [];
    fstrings = [];
    unterminated = false;
    error = undefined;
    head = null;
    colonSeen = false;
  };
  const begin = (at: number) => {
    if (started) return;
    started = true;
    startLine = line;
    if (!afterSemicolon) indent = at - lineStart;
    stmtAfterSemicolon = afterSemicolon;
  };
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      // A continuation into a blank or comment-only line, or into the end of the file, compiles on some Python
      // versions only (3.9 rejects the end-of-file form). So does one before the statement's first token: after
      // leading whitespace (` \` then `X = 1`) CPython 3.11 and 3.13 report an unexpected indent, 3.9 compiles it.
      let j = i + 2;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\f')) j++;
      const intoNothing = j >= n || src[j] === '\n' || src[j] === '#';
      if (intoNothing || !started) {
        if (!started) {
          begin(i);
          buf += '\\';
        }
        error ??= intoNothing
          ? 'a line continuation into a blank line, a comment or the end of the file (whether that compiles depends on the Python version)'
          : 'a line continuation before the first token of a statement (whether that compiles depends on the Python version)';
      }
      i += 2;
      line++;
      lineStart = i;
      buf += ' ';
      continue;
    }
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      if (depth === 0) {
        flush();
        afterSemicolon = false;
      } else buf += ' ';
      continue;
    }
    let prefix = '';
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(src);
    if (word) {
      const after = i + word[0].length;
      if (!(STRING_PREFIX.test(word[0]) && (src[after] === '"' || src[after] === "'"))) {
        if (!started) head = COMPOUND_HEADS.has(word[0]) ? 'hard' : SOFT_COMPOUND_HEADS.has(word[0]) ? 'soft' : null;
        begin(i);
        buf += word[0];
        i = after;
        continue;
      }
      prefix = word[0];
    }
    const quoteAt = i + prefix.length;
    if (src[quoteAt] === '"' || src[quoteAt] === "'") {
      begin(i);
      const q = src.startsWith(src[quoteAt].repeat(3), quoteAt) ? src[quoteAt].repeat(3) : src[quoteAt];
      i = quoteAt + q.length;
      const contentStart = i;
      let contentEnd = -1;
      while (i < n) {
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
          if (q.length === 1) break; // unterminated single-line string: stop at the line end
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (contentEnd < 0) unterminated = true;
      const content = src.slice(contentStart, contentEnd < 0 ? Math.min(i, n) : contentEnd);
      strings.push(content);
      prefixes.push(prefix);
      if (/[ft]/i.test(prefix)) fstrings.push(content);
      buf += "''";
      continue;
    }
    // On a compound header's line the ';' belongs to the one-line suite (a soft keyword such as `match` heads a
    // compound statement only when a ':' follows it; joining a line too many only makes it unreadable, never wrong).
    if (c === ';' && depth === 0 && !(head === 'hard' || (head === 'soft' && colonSeen))) {
      if (!started) {
        // `;;`, or a ';' starting a line: an empty statement, which Python rejects.
        begin(i);
        buf += ';';
        error ??= 'an empty statement before ";" (not valid Python)';
        i++;
        continue;
      }
      flush();
      afterSemicolon = true;
      i++;
      continue;
    }
    if (c === ':' && depth === 0) colonSeen = true;
    if (c !== ' ' && c !== '\t' && c !== '\f') begin(i);
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
    const parts = splitTopLevel(inner, ',');
    // Parentheses without a comma only group: `(Chain.ETH)` is the member itself, not a tuple (`x in Chain.ETH` and
    // frozenset(Chain.ETH) raise TypeError), while `((Chain.ETH,))` is the inner tuple.
    if (e[0] === '(' && parts.length === 1 && inner.trim()) return collectionElements(inner);
    return parts.map((x) => x.trim()).filter(Boolean);
  }
  const parts = splitTopLevel(e, ',');
  return parts.length > 1 ? parts.map((x) => x.trim()).filter(Boolean) : null; // bare tuple "Chain.A, Chain.B"
}

const SWAP_VAR = 'SWAP_DISABLED_CHAINS';

interface PyToken {
  t: string;
  kind: 'name' | 'number' | 'string' | 'op';
  /** Bracket depth the token is at (an opening bracket is at the outer depth, its contents one deeper). */
  depth: number;
  /** String tokens: index of the literal in the statement's `strings` / `prefixes`. */
  si?: number;
}
const PY_OPS = ['**=', '//=', '>>=', '<<=', '...', '->', ':=', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '**', '//', '<<', '>>'];
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

/** Tokens of one logical statement from pythonStatements (string literals are already ''). */
function pyTokens(code: string): PyToken[] {
  const out: PyToken[] = [];
  const NAME = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
  // A number is read up to the next character that cannot continue it, as Python's tokenizer does; an exponent sign
  // belongs to a decimal literal (1e-5), while 0x1e+5 is 0x1e plus 5. Validity is checked against NUMBER_LITERAL.
  const PREFIXED_NUMBER = /0[xXbBoO][\w.]*/y;
  const NUMBER = /(?:\d|\.\d)(?:[eE][+-]\d|[\w.])*/y;
  let depth = 0;
  let si = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (code.startsWith("''", i)) {
      out.push({ t: "''", kind: 'string', depth, si: si++ });
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
    PREFIXED_NUMBER.lastIndex = i;
    NUMBER.lastIndex = i;
    const num = PREFIXED_NUMBER.exec(code) ?? NUMBER.exec(code);
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

// The module is read with an allowlist, not by looking for ways the switch could change: Python offers too many
// (target lists, attribute and subscript targets, mutating calls on the value or an alias, setattr/exec/globals() and
// every route to them such as builtins.exec, f.__globals__ or frame.f_globals, star imports, NFKC-equivalent names,
// code in f-string fields). A value is only reported when every statement is a form that cannot run such code.

/** The only callables a value may use: they build a new collection and cannot rebind or modify a module name. */
const CONSTRUCTORS = new Set(['frozenset', 'set', 'tuple', 'list', 'dict']);
/** Methods of tuple/list/set/frozenset that only read the collection; callable on the switch itself. */
const READ_ONLY_METHODS = new Set(['union', 'intersection', 'difference', 'symmetric_difference', 'issubset', 'issuperset', 'isdisjoint', 'copy', 'count', 'index']);
/** Builtin exception classes (CPython 3.9 to 3.14): constructing and raising one runs no code of this module. */
const PY_EXCEPTIONS = new Set(
  (
    'ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError BrokenPipeError BufferError BytesWarning ' +
    'ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError EncodingWarning ' +
    'EnvironmentError Exception ExceptionGroup FileExistsError FileNotFoundError FloatingPointError FutureWarning GeneratorExit IOError ImportError ' +
    'ImportWarning IndentationError IndexError InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError ' +
    'NameError NotADirectoryError NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError ' +
    'PythonFinalizationError RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError ' +
    'SyntaxWarning SystemError SystemExit TabError TimeoutError TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError ' +
    'UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning ZeroDivisionError'
  ).split(' '),
);
/** Every other public builtin name (dir(builtins) with the site module, CPython 3.9 to 3.14). */
const PY_BUILTINS = new Set([
  ...PY_EXCEPTIONS,
  ...(
    'Ellipsis False None NotImplemented True abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex ' +
    'copyright credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input ' +
    'int isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit range repr ' +
    'reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip WindowsError'
  ).split(' '),
]);
const OPERATOR_KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is']);
const OPERATORS = new Set(['+', '-', '*', '/', '//', '%', '**', '@', '|', '&', '^', '~', '<<', '>>', '==', '!=', '<', '>', '<=', '>=']);
/** Python's numeric literal grammar: '_' only between digits, no leading zeros in non-zero decimal integers. */
const NUMBER_LITERAL = (() => {
  const digits = '\\d(?:_?\\d)*';
  const exponent = `[eE][+-]?${digits}`;
  const pointFloat = `(?:(?:${digits})?\\.${digits}|${digits}\\.)`;
  const float = `(?:${pointFloat}(?:${exponent})?|${digits}${exponent})`;
  const integer = '(?:[1-9](?:_?\\d)*|0+(?:_?0)*|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|0[xX](?:_?[\\da-fA-F])+)';
  return new RegExp(`^(?:(?:${float}|${digits})[jJ]|${float}|${integer})$`);
})();
const isDunder = (s: string) => /^__\w*__$/.test(s);
const isName = (x: PyToken | undefined): boolean => !!x && x.kind === 'name' && !PY_KEYWORDS.has(x.t);
const plainName = (x: PyToken | undefined): boolean => !!x && isName(x) && !isDunder(x.t);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Facts about the whole module that decide whether a statement is inert. */
interface ModuleFacts {
  /** A `from x import *` is present: it may bind any name, the constructors and exception classes included. */
  star: boolean;
  /** Module names bound anywhere by imports, assignments and defs. */
  bound: Set<string>;
  /** How often each name occurs in the module's code (outside strings and comments). */
  uses: Map<string, number>;
}

function balanced(toks: PyToken[]): boolean {
  const stack: string[] = [];
  for (const x of toks) {
    if (x.kind !== 'op') continue;
    if (x.t === '(' || x.t === '[' || x.t === '{') stack.push(x.t);
    else if (CLOSERS[x.t] && stack.pop() !== CLOSERS[x.t]) return false;
  }
  return stack.length === 0;
}

// ---- Would the module compile? ----------------------------------------------------------------------------------
// A module CPython refuses to compile has no value at all, so every statement the allowlist accepts is also checked
// against Python's grammar. Where Python versions disagree (t-strings, \N{...} names, continuation lines into nothing)
// the answer is unknown too.

/**
 * Bracket nesting this reader follows. Python's tokenizer stops at 200 and older parsers much earlier, so deeper
 * nesting is left unknown; it also bounds the recursion of exprSyntaxProblem.
 */
const MAX_BRACKET_DEPTH = 50;
/**
 * Upper bound on how deeply one expression's syntax tree may nest. CPython compiles syntax trees recursively and gives
 * up at version-dependent depths (`X = Chain` followed by 3000 `.ETH` fails on 3.9 and 3.11 but not on 3.13, 10000
 * `.ETH` on all three; 3000 `+ 1` terms fail on 3.11 only); far below all of them, deeper expressions are unknown.
 */
const MAX_EXPR_DEPTH = 100;
/** Longest numeric literal read. Python 3.11 and later reject decimal integer literals of more than 4300 digits. */
const MAX_NUMBER_LENGTH = 1000;

/** Why a string literal (prefix and content as written) would not compile, or might not on some Python version. */
function literalProblem(prefix: string, content: string): string | null {
  const p = prefix.toLowerCase();
  if (p.includes('t')) return 'a t-string (template strings compile on Python 3.14 and later only)';
  const bytes = p.includes('b');
  if (bytes && /[^\x00-\x7f]/.test(content)) return 'a bytes literal with non-ASCII characters (not valid Python)';
  if (p.includes('r')) return null;
  for (let j = 0; j < content.length; j++) {
    if (content[j] !== '\\') continue;
    const e = content[j + 1];
    const hex = (len: number) => new RegExp(`^[0-9a-fA-F]{${len}}`).exec(content.slice(j + 2, j + 2 + len))?.[0] ?? null;
    if (e === 'x' && !hex(2)) return 'a truncated \\x escape in a string literal (not valid Python)';
    if (!bytes && e === 'u' && !hex(4)) return 'a truncated \\u escape in a string literal (not valid Python)';
    if (!bytes && e === 'U') {
      const h = hex(8);
      if (!h || parseInt(h, 16) > 0x10ffff) return 'an invalid \\U escape in a string literal (not valid Python)';
    }
    if (!bytes && e === 'N') return 'a \\N{...} escape in a string literal (whether that character name exists, and so whether the module compiles, cannot be checked here)';
    j++; // the escaped character (a quote, a backslash, a line break, ...)
  }
  return null;
}

/** Adjacent string literals are one concatenated literal; Python rejects mixing bytes with str in it. */
function stringRunProblem(toks: PyToken[], prefixes: string[]): string | null {
  let kind: string | null = null;
  for (const x of toks) {
    if (x.kind !== 'string') {
      kind = null;
      continue;
    }
    const k = /b/i.test(prefixes[x.si ?? -1] ?? '') ? 'bytes' : 'str';
    if (kind && kind !== k) return 'bytes and str literals written next to each other (not valid Python)';
    kind = k;
  }
  return null;
}

class PySyntaxError extends Error {}
const COMPARE_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const BINARY_LEVELS = [['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '//', '%', '@']];

/**
 * Whether `toks` is, in Python's grammar, one expression ('expr'), an assignment value such as `a, *b` ('list') or the
 * inside of a call's parentheses ('args'). Covers what valueProblem and annotationProblem admit (literals, names,
 * attribute reads, calls, subscripts, displays, unary, binary, comparison and boolean operators); anything else is
 * reported. Returns why not, or null. Unary and binary chains are read in loops, and bracket nesting is bounded by
 * MAX_BRACKET_DEPTH before this runs, so no input exhausts the stack.
 *
 * Each rule also returns an upper bound on the depth of the syntax tree it read (a chain of n operators, attribute
 * reads, calls or subscripts adds n to its deepest operand; a display or call adds one to its deepest item). An
 * expression deeper than MAX_EXPR_DEPTH is reported: whether CPython compiles it depends on the version.
 */
function exprSyntaxProblem(toks: PyToken[], form: 'expr' | 'list' | 'args'): string | null {
  let k = 0;
  const fail = (what: string): never => {
    throw new PySyntaxError(what);
  };
  const op = (t: string, o = 0) => toks[k + o]?.kind === 'op' && toks[k + o].t === t;
  const kw = (t: string, o = 0) => toks[k + o]?.kind === 'name' && toks[k + o].t === t;
  const here = () => (toks[k] ? `"${toks[k].t}"` : 'the end');
  const expect = (t: string) => {
    if (!op(t)) fail(`${here()} where "${t}" belongs`);
    k++;
  };
  const atEnd = (end: string | null) => (end === null ? k >= toks.length : op(end));

  const atom = (): number => {
    const x = toks[k];
    if (!x) return fail('the end, where an operand belongs');
    if (x.kind === 'string') {
      while (toks[k]?.kind === 'string') k++; // implicit concatenation
      return 1;
    }
    if (x.kind === 'number') {
      if (!NUMBER_LITERAL.test(x.t)) fail(`the number "${x.t}"`);
      k++;
      return 1;
    }
    if (x.kind === 'name') {
      if (PY_KEYWORDS.has(x.t) && x.t !== 'True' && x.t !== 'False' && x.t !== 'None') fail(`"${x.t}"`);
      k++;
      return 1;
    }
    if (op('...')) {
      k++;
      return 1;
    }
    if (op('(')) {
      k++;
      if (op(')')) {
        k++;
        return 1;
      }
      const r = items(')');
      if (r.starred && !r.comma) fail('a starred expression outside a tuple');
      expect(')');
      return r.depth + 1;
    }
    if (op('[')) {
      k++;
      const d = op(']') ? 0 : items(']').depth;
      expect(']');
      return d + 1;
    }
    if (op('{')) {
      k++;
      const d = op('}') ? 0 : dictOrSet();
      expect('}');
      return d + 1;
    }
    return fail(here());
  };
  const primary = (): number => {
    let d = atom();
    for (;;) {
      if (op('.')) {
        k++;
        if (!isName(toks[k])) fail(`${here()} after "."`);
        k++;
        d += 1;
      } else if (op('(')) {
        k++;
        d = Math.max(d, args(')')) + 1;
        expect(')');
      } else if (op('[')) {
        k++;
        d = Math.max(d, subscript()) + 1;
        expect(']');
      } else return d;
    }
  };
  const unary = (): number => {
    let n = 0;
    while (op('+') || op('-') || op('~')) {
      k++;
      n++;
    }
    return n;
  };
  // factor := unary* primary ('**' unary* primary)*: the token sequences Python's factor/power rules accept.
  const factor = (): number => {
    let extra = unary();
    let d = primary();
    while (op('**')) {
      k++;
      extra += 1 + unary();
      d = Math.max(d, primary());
    }
    return d + extra;
  };
  const binary = (level: number): number => {
    if (level === BINARY_LEVELS.length) return factor();
    let d = binary(level + 1);
    let extra = 0;
    while (toks[k]?.kind === 'op' && BINARY_LEVELS[level].includes(toks[k].t)) {
      k++;
      extra++;
      d = Math.max(d, binary(level + 1));
    }
    return d + extra;
  };
  const comparison = (): number => {
    let d = binary(0);
    let compared = false;
    for (;;) {
      if (toks[k]?.kind === 'op' && COMPARE_OPS.has(toks[k].t)) k++;
      else if (kw('in')) k++;
      else if (kw('not') && kw('in', 1)) k += 2;
      else if (kw('is')) k += kw('not', 1) ? 2 : 1;
      else return d + (compared ? 1 : 0);
      compared = true;
      d = Math.max(d, binary(0));
    }
  };
  // expression := 'not'* comparison (('and' | 'or') 'not'* comparison)*, the language of disjunction/conjunction/inversion.
  const expression = (): number => {
    let d = 0;
    let extra = 0;
    for (;;) {
      while (kw('not')) {
        k++;
        extra++;
      }
      d = Math.max(d, comparison());
      if (!kw('and') && !kw('or')) return d + extra;
      k++;
      extra++;
    }
  };
  /** Comma-separated (possibly starred) expressions up to `end` (null: the end of the tokens); a trailing comma is allowed. */
  const items = (end: string | null) => {
    let comma = false;
    let starred = false;
    let depth = 0;
    for (;;) {
      if (op('*')) {
        k++;
        depth = Math.max(depth, binary(0) + 1);
        starred = true;
      } else depth = Math.max(depth, expression());
      if (!op(',')) break;
      k++;
      comma = true;
      if (atEnd(end)) break;
    }
    return { comma, starred, depth: depth + (comma ? 1 : 0) };
  };
  const dictOrSet = (): number => {
    let dict: boolean;
    let d: number;
    if (op('**')) {
      k++;
      d = binary(0) + 1;
      dict = true;
    } else if (op('*')) {
      k++;
      d = binary(0) + 1;
      dict = false;
    } else {
      d = expression();
      dict = op(':');
      if (dict) {
        k++;
        d = Math.max(d, expression());
      }
    }
    while (op(',')) {
      k++;
      if (op('}')) return d;
      if (dict && op('**')) {
        k++;
        d = Math.max(d, binary(0) + 1);
      } else if (dict) {
        d = Math.max(d, expression());
        expect(':');
        d = Math.max(d, expression());
      } else if (op('*')) {
        k++;
        d = Math.max(d, binary(0) + 1);
      } else d = Math.max(d, expression());
    }
    return d;
  };
  /** Call arguments up to `end`, in Python's order: no positional argument after name=value or **mapping, no *iterable after **mapping. */
  const args = (end: string | null): number => {
    let keyword = false;
    let mapping = false;
    let d = 0;
    while (!atEnd(end)) {
      if (op('*')) {
        if (mapping) fail('"*" after "**" in a call');
        k++;
        d = Math.max(d, expression() + 1);
      } else if (op('**')) {
        k++;
        d = Math.max(d, expression() + 1);
        mapping = true;
      } else if (isName(toks[k]) && op('=', 1)) {
        k += 2;
        d = Math.max(d, expression() + 1);
        keyword = true;
      } else {
        if (keyword || mapping) fail('a positional argument after a keyword argument');
        d = Math.max(d, expression());
      }
      if (!op(',')) return d;
      k++;
    }
    return d;
  };
  const subscript = (): number => {
    let d = 0;
    let tuple = false;
    for (;;) {
      let s = 0;
      if (!op(':')) s = expression();
      if (op(':')) {
        k++;
        if (!op(':') && !op(',') && !op(']')) s = Math.max(s, expression());
        if (op(':')) {
          k++;
          if (!op(',') && !op(']')) s = Math.max(s, expression());
        }
        s += 1; // a slice node
      }
      d = Math.max(d, s);
      if (!op(',')) return d + (tuple ? 1 : 0);
      k++;
      tuple = true;
      if (op(']')) return d + 1;
    }
  };

  try {
    let depth: number;
    if (form === 'expr') depth = expression();
    else if (form === 'list') {
      const r = items(null);
      if (r.starred && !r.comma) fail('a starred expression outside a tuple');
      depth = r.depth;
    } else depth = args(null);
    if (k < toks.length) fail(here());
    if (depth > MAX_EXPR_DEPTH) return `nests more than ${MAX_EXPR_DEPTH} levels deep (operators, attribute reads, calls; whether CPython compiles that depends on the version)`;
    return null;
  } catch (err) {
    if (err instanceof PySyntaxError) return `is not valid Python or uses a form this reader does not parse (at ${err.message})`;
    throw err;
  }
}

/** __future__ features every supported Python version knows; barry_as_FLUFL is left out on purpose (it changes how != parses). */
const FUTURE_FEATURES = new Set(['nested_scopes', 'generators', 'division', 'absolute_import', 'with_statement', 'print_function', 'unicode_literals', 'generator_stop', 'annotations']);

/** Why a `from __future__ import ...` statement would not compile (or might not), or null; `prologue` = only a docstring and __future__ imports precede it. */
function futureImportProblem(toks: PyToken[], prologue: boolean): string | null {
  let m = 1;
  while (toks[m]?.t === '.' || toks[m]?.t === '...') m++;
  if (toks[m]?.t !== '__future__' || toks[m + 1]?.t !== 'import') return null;
  if (m > 1) return 'a relative import of __future__ (Python versions disagree on whether it is a future statement)';
  if (!prologue) return 'a __future__ import after other statements (not valid Python)';
  if (isStarImport(toks)) return 'from __future__ import * (not valid Python)';
  const rest = toks.slice(m + 2);
  for (let j = 0; j < rest.length; j++) {
    if (rest[j].kind !== 'name' || (j > 0 && rest[j - 1].t !== '(' && rest[j - 1].t !== ',')) continue;
    if (rest[j].t === 'barry_as_FLUFL') return 'from __future__ import barry_as_FLUFL (it changes how "!=" is read)';
    if (!FUTURE_FEATURES.has(rest[j].t)) return `an unknown __future__ feature ${rest[j].t} (not valid Python)`;
  }
  return null;
}

/** Index of the bracket closing toks[open] (same depth), or -1. */
function closingIndex(toks: PyToken[], open: number): number {
  const close = { '(': ')', '[': ']', '{': '}' }[toks[open]?.t ?? ''];
  if (!close) return -1;
  for (let k = open + 1; k < toks.length; k++) if (toks[k].t === close && toks[k].depth === toks[open].depth) return k;
  return -1;
}

/** End index of a dotted name (a.b.c) starting at k, or -1. */
function dottedEnd(toks: PyToken[], k: number): number {
  if (!isName(toks[k])) return -1;
  let j = k + 1;
  while (toks[j]?.t === '.' && isName(toks[j + 1])) j += 2;
  return j;
}

const isStarImport = (toks: PyToken[]) => toks[0]?.t === 'from' && toks[toks.length - 1]?.t === '*' && toks[toks.length - 2]?.t === 'import';

/** Names bound by a plain `import a.b [as c], ...` or `from x import a [as b], ...` statement; null for any other form (star imports included). */
function importBindings(toks: PyToken[]): string[] | null {
  const bound: string[] = [];
  if (toks[0]?.t === 'import') {
    let k = 1;
    for (;;) {
      const end = dottedEnd(toks, k);
      if (end < 0) return null;
      if (toks[end]?.t === 'as') {
        if (!isName(toks[end + 1])) return null;
        bound.push(toks[end + 1].t);
        k = end + 2;
      } else {
        bound.push(toks[k].t);
        k = end;
      }
      if (k === toks.length) return bound;
      if (toks[k].t !== ',') return null;
      k++;
    }
  }
  if (toks[0]?.t === 'from') {
    let k = 1;
    while (toks[k]?.t === '.' || toks[k]?.t === '...') k++;
    if (isName(toks[k])) k = dottedEnd(toks, k);
    else if (k === 1) return null;
    if (toks[k]?.t !== 'import') return null;
    k++;
    const paren = toks[k]?.t === '(';
    if (paren) k++;
    for (;;) {
      if (!isName(toks[k])) return null;
      let name = toks[k].t;
      k++;
      if (toks[k]?.t === 'as') {
        if (!isName(toks[k + 1])) return null;
        name = toks[k + 1].t;
        k += 2;
      }
      bound.push(name);
      if (paren && toks[k]?.t === ',' && toks[k + 1]?.t === ')') k++;
      if (paren && toks[k]?.t === ')') return k + 1 === toks.length ? bound : null;
      if (!paren && k === toks.length) return bound;
      if (toks[k]?.t !== ',') return null;
      k++;
    }
  }
  return null;
}

/** The module names a statement binds, as far as the allowlisted forms go (other forms are rejected anyway). */
function statementBindings(toks: PyToken[]): string[] {
  if (toks[0]?.t === 'import' || toks[0]?.t === 'from') return importBindings(toks) ?? [];
  if (toks[0]?.t === 'def') return isName(toks[1]) ? [toks[1].t] : [];
  if ((plainName(toks[0]) || toks[0]?.t === '__all__') && (toks[1]?.t === '=' || (toks[1]?.t === ':' && toks.some((x) => x.depth === 0 && x.t === '=')))) return [toks[0].t];
  return [];
}

/** Why an annotation is not inert, or null. Module-level annotations are evaluated, so only names, subscripts, `|` and strings are accepted. */
function annotationProblem(toks: PyToken[]): string | null {
  if (!toks.length) return 'empty annotation';
  for (const x of toks) {
    if (x.kind === 'string' || x.t === 'None' || plainName(x)) continue;
    if (x.kind === 'op' && ['.', '[', ']', ',', '|', '...'].includes(x.t)) continue;
    return `its annotation uses "${x.t}"`;
  }
  const syntax = exprSyntaxProblem(toks, 'expr');
  return syntax ? `its annotation ${syntax}` : null;
}

/**
 * Why an expression could run code that changes a module name, or null when it is inert: literals, names, attribute
 * reads, operators, tuple/list/set/dict displays, calls to the collection constructors (not when a star import may
 * have rebound them) and, after the definition, read-only methods called on the switch itself. No other call, no
 * subscript, comprehension, lambda, conditional expression, walrus or keyword argument. The tokens must also form
 * `form` in Python's grammar (one expression, an assignment value, or call arguments): a module that does not compile
 * has no value.
 */
function valueProblem(toks: PyToken[], facts: ModuleFacts, afterDef: boolean, form: 'expr' | 'list' | 'args' = 'expr'): string | null {
  const problem = inertValueProblem(toks, facts, afterDef);
  return problem ?? exprSyntaxProblem(toks, form);
}

function inertValueProblem(toks: PyToken[], facts: ModuleFacts, afterDef: boolean): string | null {
  if (!toks.length) return 'no value';
  const open: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const x = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (x.kind === 'string') continue;
    if (x.kind === 'number') {
      if (!NUMBER_LITERAL.test(x.t)) return `unrecognised number "${x.t}"`;
      continue;
    }
    if (x.kind === 'name') {
      if (x.t === 'True' || x.t === 'False' || x.t === 'None' || OPERATOR_KEYWORDS.has(x.t)) continue;
      if (PY_KEYWORDS.has(x.t)) return `uses "${x.t}"`;
      if (isDunder(x.t)) return `uses ${x.t}`;
      if (next?.t === '(') {
        if (prev?.t === '.') {
          const receiver = toks[k - 2];
          const onSwitch = receiver?.kind === 'name' && receiver.t === SWAP_VAR && toks[k - 3]?.t !== '.';
          if (!(onSwitch && afterDef && READ_ONLY_METHODS.has(x.t))) return `calls .${x.t}()`;
        } else if (!CONSTRUCTORS.has(x.t) || facts.star) return `calls ${x.t}()`;
        continue;
      }
      if (next?.t === '[') return `subscripts ${x.t}[…]`;
      continue;
    }
    switch (x.t) {
      case '(':
      case '[':
      case '{':
        if (prev && (prev.kind === 'string' || prev.kind === 'number' || prev.t === ')' || prev.t === ']' || prev.t === '}')) return 'calls or subscripts the result of an expression';
        open.push(x.t);
        continue;
      case ')':
      case ']':
      case '}':
        open.pop();
        continue;
      case ',':
      case '...':
        continue;
      case '.':
        if (prev && (prev.kind === 'name' || prev.kind === 'string' || prev.t === ')' || prev.t === ']' || prev.t === '}') && plainName(next)) continue;
        return 'uses "." other than to read a plain attribute';
      case ':':
        if (open[open.length - 1] === '{') continue; // dict display
        return 'uses ":" outside a dict display';
      default:
        if (OPERATORS.has(x.t)) continue;
        return `uses "${x.t}"`;
    }
  }
  return null;
}

/** One-line `def NAME(PARAMS) [-> T]: pass` (or `...` or a docstring): defaults and annotations inert, a body that does nothing. */
function defProblem(toks: PyToken[], facts: ModuleFacts, afterDef: boolean): string | null {
  const other = 'a def other than a one-line `def name(...): pass` without decorators';
  if (!plainName(toks[1]) || toks[2]?.t !== '(') return other;
  const close = closingIndex(toks, 2);
  if (close < 0) return other;
  const level = toks[2].depth + 1;
  const params: PyToken[][] = [[]];
  for (const x of toks.slice(3, close)) {
    if (x.t === ',' && x.depth === level) params.push([]);
    else params[params.length - 1].push(x);
  }
  // A single trailing comma after a parameter is allowed; any other empty parameter (`f(,)`, `f(a,,b)`) is not valid Python.
  const trailingComma = params.length > 1 && !params[params.length - 1].length;
  if (trailingComma) params.pop();
  else if (params.length === 1 && !params[0].length) params.pop(); // no parameters
  const invalid = (why: string) => `a parameter list that is not valid Python (${why})`;
  if (params.some((p) => !p.length)) return invalid('an empty parameter');
  // Python's ordering rules: '/' after at least one parameter and before any '*'; one '*' or *args; nothing after
  // **kwargs; a bare '*' needs a named parameter after it; no default-less positional parameter after a default.
  const names = new Set<string>();
  let slash = false;
  let star: 'none' | 'bare' | 'args' = 'none';
  let namedAfterBare = false;
  let kwargs = false;
  let defaults = false;
  for (const [pi, p] of params.entries()) {
    if (kwargs) return invalid('a parameter after **kwargs');
    if (p.length === 1 && p[0].t === '/') {
      if (slash || star !== 'none' || pi === 0) return invalid('a misplaced "/"');
      slash = true;
      continue;
    }
    if (p.length === 1 && p[0].t === '*') {
      if (star !== 'none') return invalid('a second "*"');
      star = 'bare';
      continue;
    }
    const kind = p[0].t === '*' ? 'args' : p[0].t === '**' ? 'kwargs' : 'plain';
    let j = kind === 'plain' ? 0 : 1;
    if (!isName(p[j])) return other;
    const name = p[j].t;
    if (name === '__debug__') return invalid('a parameter named __debug__');
    if (names.has(name)) return invalid(`the parameter ${name} twice`);
    names.add(name);
    j++;
    const eq = p.findIndex((x, i) => i >= j && x.t === '=' && x.depth === level);
    if (p[j]?.t === ':') {
      const annotation = annotationProblem(p.slice(j + 1, eq < 0 ? undefined : eq));
      if (annotation) return annotation;
    } else if (j < p.length && eq !== j) return other;
    if (kind === 'args') {
      if (star !== 'none') return invalid('a second "*"');
      if (eq >= 0) return invalid('a default for *args');
      star = 'args';
    } else if (kind === 'kwargs') {
      if (eq >= 0) return invalid('a default for **kwargs');
      if (star === 'bare' && !namedAfterBare) return invalid('no named parameter after a bare "*"');
      kwargs = true;
    } else if (star === 'none') {
      if (eq >= 0) defaults = true;
      else if (defaults) return invalid('a parameter without a default after one with a default');
    } else if (star === 'bare') namedAfterBare = true;
    if (eq >= 0) {
      const value = valueProblem(p.slice(eq + 1), facts, afterDef);
      if (value) return `a default value ${value}`;
    }
  }
  if (star === 'bare' && !namedAfterBare) return invalid('no named parameter after a bare "*"');
  let k = close + 1;
  if (toks[k]?.t === '->') {
    const colon = toks.findIndex((x, i) => i > k && x.depth === 0 && x.t === ':');
    if (colon < 0) return other;
    const annotation = annotationProblem(toks.slice(k + 1, colon));
    if (annotation) return annotation;
    k = colon;
  }
  if (toks[k]?.t !== ':') return other;
  const body = toks.slice(k + 1);
  if (body.length === 1 && (body[0].t === 'pass' || body[0].t === '...')) return null;
  if (body.length && body.every((x) => x.kind === 'string')) return null;
  return other;
}

/** One-line `if COND: raise BuiltinError(ARGS)` guard: an inert condition, and raising stops the module. */
function ifRaiseProblem(toks: PyToken[], facts: ModuleFacts, afterDef: boolean): string | null {
  const other = 'an if statement other than a one-line `if ...: raise BuiltinError(...)` guard';
  const colon = toks.findIndex((x, i) => i > 0 && x.depth === 0 && x.t === ':');
  if (colon < 2) return other;
  const cond = valueProblem(toks.slice(1, colon), facts, afterDef);
  if (cond) return `its condition ${cond}`;
  const body = toks.slice(colon + 1);
  if (body[0]?.t !== 'raise') return other;
  const exc = body[1];
  if (!plainName(exc) || !PY_EXCEPTIONS.has(exc.t) || facts.bound.has(exc.t) || facts.star) return `it raises ${exc?.t ?? 'nothing'}, not a builtin exception class the module leaves alone`;
  if (body.length === 2) return null;
  if (body[2]?.t !== '(' || closingIndex(body, 2) !== body.length - 1) return other;
  if (body.length === 4) return null;
  const args = valueProblem(body.slice(3, -1), facts, afterDef, 'args');
  return args ? `its exception arguments ${args}` : null;
}

/**
 * Expression statement `root.a.b(ARGS)` whose root name is defined nowhere: not bound in the module, not a builtin,
 * no star import, used nowhere else. Python looks the root up first and raises NameError, so nothing in the call
 * runs and the module stops there. Any other call runs code this reader cannot see.
 */
function unboundCallProblem(toks: PyToken[], facts: ModuleFacts, afterDef: boolean): string | null {
  const root = toks[0];
  let k = 1;
  while (toks[k]?.t === '.' && plainName(toks[k + 1])) k += 2;
  const callee = toks
    .slice(0, Math.min(k, 21))
    .map((x) => x.t)
    .join('')
    .concat(k > 21 ? '…' : '');
  if (toks[k]?.t !== '(' || closingIndex(toks, k) !== toks.length - 1) return 'not an import, docstring or NAME = value statement (a call on a computed value, a subscript, ...)';
  if (facts.star || facts.bound.has(root.t) || PY_BUILTINS.has(root.t) || root.t === 'Chain' || root.t.startsWith('_') || (facts.uses.get(root.t) ?? 0) > 1) return `it calls ${callee}(), code this reader cannot see`;
  if (k + 1 < toks.length - 1) {
    const args = valueProblem(toks.slice(k + 1, -1), facts, afterDef, 'args');
    if (args) return `the arguments of ${callee}() ${args}`;
  }
  // The whole call must compile too: a very long attribute chain before it nests as deep as any operator chain.
  const call = exprSyntaxProblem(toks, 'expr');
  return call ? `the call to ${callee}() ${call}` : null;
}

/**
 * Why a top-level statement is not one of the inert forms (or would not compile), or null; `bind` receives the module
 * names it binds. `prologue`: only a docstring and __future__ imports come before this statement.
 */
function statementProblem(s: PyStatement, toksIn: PyToken[], facts: ModuleFacts, afterDef: boolean, bind: (name: string, how: 'import' | 'assignment' | 'def') => void, prologue = false): string | null {
  if (s.error) return s.error;
  if (s.unterminated) return 'a string literal is not closed';
  if (/[^\t\f\x20-\x7e]/.test(s.code)) return 'non-ASCII or control characters outside strings and comments (Python normalises identifiers, so names cannot be compared as written)';
  if (s.indent > 0) return 'indented code inside a block';
  if ((s.fstrings ?? []).some((f) => /[{}]/.test(f.replace(/\{\{|\}\}/g, '')))) return 'an f-string or t-string replacement field (code that runs)';
  for (const [j, content] of s.strings.entries()) {
    const literal = literalProblem(s.prefixes[j] ?? '', content);
    if (literal) return literal;
  }
  let toks = toksIn;
  if (!balanced(toks)) return 'unbalanced brackets';
  if (toks.some((x) => x.depth > MAX_BRACKET_DEPTH)) return `brackets nested more than ${MAX_BRACKET_DEPTH} deep (whether that compiles depends on the Python version)`;
  const longNumber = toks.find((x) => x.kind === 'number' && x.t.length > MAX_NUMBER_LENGTH);
  if (longNumber) return `a numeric literal of ${longNumber.t.length} characters (Python 3.11 and later refuse decimal integers over 4300 digits, so whether it compiles depends on the version)`;
  const strings = stringRunProblem(toks, s.prefixes);
  if (strings) return strings;
  const head = toks[0];
  if (head?.kind === 'name' && COMPOUND_HEADS.has(head.t)) {
    // A compound statement cannot follow ';', and everything after ';' on its header line is the block's one-line
    // suite: `def f(): pass; X = 1` assigns X inside f, so it is never read as a module-level statement.
    if (s.afterSemicolon) return `a ${head.t} statement after ";" (not valid Python)`;
    const semis = toks.flatMap((x, j) => (x.kind === 'op' && x.t === ';' && x.depth === 0 ? [j] : []));
    if (semis.length === 1 && semis[0] === toks.length - 1) toks = toks.slice(0, -1); // one trailing ';' is allowed
    else if (semis.length) return `a one-line ${head.t} statement whose suite continues after ";" (those statements run inside the block, not at module level)`;
  }
  if (toks.every((x) => x.kind === 'string')) return null; // docstring or other bare string
  if (toks.length === 1 && toks[0].t === 'pass') return null;
  if (toks[0].t === 'import' || toks[0].t === 'from') {
    const future = toks[0].t === 'from' ? futureImportProblem(toks, prologue) : null;
    if (future) return future;
    // A star import may bind any name, SWAP_DISABLED_CHAINS included, and no later definition certainly wins over it:
    // when the definition stores its value, the star-imported object it replaces is released and its finaliser
    // (__del__, a weakref callback) runs code from the other module right after the store, which can rebind the switch.
    // CPython 3.9, 3.11 and 3.13 end with that code's value, not the definition's.
    if (isStarImport(toks)) {
      return afterDef
        ? 'a star import after the definition (it can rebind the switch)'
        : 'a star import comes before the definition: it can bind the switch to an object whose finaliser runs when the definition replaces it and can rebind the switch, so the definition does not certainly win';
    }
    const names = importBindings(toks);
    if (!names) return 'an import form not recognised';
    // `from x import __builtins__` and the like change how this module resolves names.
    const dunder = names.find(isDunder);
    if (dunder) return `it imports the name ${dunder}`;
    for (const name of names) bind(name, 'import');
    return null;
  }
  if (toks[0].t === 'def') {
    const problem = defProblem(toks, facts, afterDef);
    if (!problem) bind(toks[1].t, 'def');
    return problem;
  }
  if (toks[0].t === 'if') return ifRaiseProblem(toks, facts, afterDef);
  const target = plainName(toks[0]) || toks[0].t === '__all__';
  if (target && (toks[1]?.t === '=' || toks[1]?.t === ':')) {
    let eq = -1;
    for (let k = 1; k < toks.length; k++) {
      if (toks[k].depth !== 0 || toks[k].t !== '=') continue;
      if (eq >= 0) return 'a chained assignment';
      eq = k;
    }
    if (toks[1].t === ':') {
      const annotation = annotationProblem(toks.slice(2, eq < 0 ? undefined : eq));
      if (annotation) return annotation;
    }
    if (eq < 0) return null; // annotation only: binds nothing
    const value = valueProblem(toks.slice(eq + 1), facts, afterDef, 'list');
    if (value) return `its value ${value}`;
    bind(toks[0].t, 'assignment');
    return null;
  }
  if (plainName(toks[0]) && (toks[1]?.t === '.' || toks[1]?.t === '(')) return unboundCallProblem(toks, facts, afterDef);
  return 'not an import, docstring or NAME = value statement (a compound statement, del, or an augmented, unpacking, attribute or subscript assignment)';
}

/** Source encodings this reader decodes like Python does (the text is read as UTF-8). */
const READABLE_ENCODING = /^(?:utf[-_]?8|ascii|us[-_]ascii)$/i;
/** Declared encodings Python accepts after a UTF-8 byte order mark (it compares the normalised name with "utf-8"; a bare "utf8" fails). */
const BOM_ENCODING = /^utf[-_]8$/i;

/** Why the file's bytes would not decode the way Python decodes them, or null. `src` still carries a leading BOM, if any. */
function encodingProblem(src: string): string | null {
  const bom = src.startsWith('\uFEFF');
  const coding = (bom ? src.slice(1) : src)
    .split(/\r\n?|\n/, 2)
    .map((l) => /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/.exec(l)?.[1])
    .find(Boolean);
  if (!coding) return null;
  if (bom && !BOM_ENCODING.test(coding)) return `the file starts with a UTF-8 byte order mark but declares the source encoding ${coding} (Python reports "encoding problem: ${coding} with BOM")`;
  if (!READABLE_ENCODING.test(coding)) return `the file declares the source encoding ${coding}, which this reader does not decode`;
  if (/ascii/i.test(coding) && /[^\x00-\x7f]/.test(src)) return `the file declares the source encoding ${coding} but contains non-ASCII characters, so Python refuses to decode it`;
  return null;
}

/**
 * Whether gate3's module-level SWAP_DISABLED_CHAINS contains Chain.ZCASH.
 * true/false only when every statement of the module is an inert form (see statementProblem: imports, docstrings,
 * annotations, `NAME[: T] = value` with inert values, one-line `def f(...): pass`, one-line `if ...: raise
 * BuiltinError(...)` guards, calls whose root name is defined nowhere), the module compiles on every Python version
 * (anything that compiles on some versions only is unknown), and the switch is bound exactly once, to a literal
 * tuple/list/set of Chain members. Anything else leaves the value unknown (null): a statement that can run code could
 * rebind or modify the switch in ways reading the file cannot rule out. A star import, or a name rebound after the
 * definition, releases an object from another module after the store, and its finaliser can rebind the switch, so
 * those are unknown too. Code in other modules (what an import runs, how Chain is defined) is outside what this file
 * can show. `src` is the decoded file, with its byte order mark if it has one.
 */
export function parseGate3Switch(src: string): { zcashDisabled: boolean | null; line: number | null; reason: string | null } {
  const stmts = pythonStatements(src);
  const toks = stmts.map((s) => pyTokens(s.code));
  const isDef = (t: PyToken[]) => t[0]?.kind === 'name' && t[0].t === SWAP_VAR && (t[1]?.t === '=' || (t[1]?.t === ':' && t.some((x) => x.depth === 0 && x.t === '=')));
  // An assignment in a compound statement's one-line suite (`if X: SWAP_DISABLED_CHAINS = ...`, `def f(): ...; SWAP_DISABLED_CHAINS = ...`).
  const inSuite = (t: PyToken[]) =>
    t[0]?.kind === 'name' &&
    (COMPOUND_HEADS.has(t[0].t) || SOFT_COMPOUND_HEADS.has(t[0].t)) &&
    t.some((x, j) => j > 0 && x.kind === 'name' && x.t === SWAP_VAR && x.depth === 0 && (t[j - 1].t === ':' || t[j - 1].t === ';') && (t[j + 1]?.t === '=' || t[j + 1]?.t === ':'));
  const defAt = stmts.findIndex((s, k) => s.indent === 0 && isDef(toks[k]));
  if (defAt < 0) {
    const nested = stmts.findIndex((_, k) => isDef(toks[k]) || inSuite(toks[k]));
    if (nested >= 0) return { zcashDisabled: null, line: stmts[nested].line, reason: `${SWAP_VAR} is only assigned inside a block (conditional or nested definition)` };
    const mention = stmts.find((_, k) => toks[k].some((x) => x.kind === 'name' && x.t === SWAP_VAR));
    return {
      zcashDisabled: null,
      line: mention?.line ?? null,
      reason: mention ? `${SWAP_VAR} is bound only in a form other than a single literal assignment (line ${mention.line}${mention.error ? `: ${mention.error}` : ''})` : `${SWAP_VAR} assignment not found`,
    };
  }
  const def = stmts[defAt];
  const unknown = (why: string) => ({ zcashDisabled: null, line: def.line, reason: `${why}; the final value of ${SWAP_VAR} is not determined statically` });

  const encoding = encodingProblem(src);
  if (encoding) return unknown(encoding);
  if (src.includes('\0')) return unknown('the file contains a NUL character, so Python refuses to compile it');

  const facts: ModuleFacts = { star: toks.some(isStarImport), bound: new Set(toks.flatMap(statementBindings)), uses: new Map() };
  for (const x of toks.flat()) if (x.kind === 'name') facts.uses.set(x.t, (facts.uses.get(x.t) ?? 0) + 1);
  const bound = new Map<string, { how: 'import' | 'assignment' | 'def'; line: number }[]>();
  // __future__ imports may only follow the module docstring (a plain str literal as the first statement) and each other.
  let prologue = true;
  for (let k = 0; k < stmts.length; k++) {
    const s = stmts[k];
    let rebound: string | null = null;
    const problem = statementProblem(s, toks[k], facts, k > defAt, (name, how) => {
      if (k > defAt && bound.has(name)) rebound ??= name;
      bound.set(name, [...(bound.get(name) ?? []), { how, line: s.line }]);
    }, prologue);
    if (problem) return unknown(`line ${s.line}: ${problem}; only statements that cannot run code (imports, docstrings, NAME = literal, ...) are read as leaving the switch unchanged`);
    // Rebinding a name after the definition releases the object it referred to (an imported one, or one built from
    // imported names), and that object's finaliser runs code from another module after the switch was stored.
    if (rebound) return unknown(`line ${s.line}: ${rebound} is bound again after the definition; the object it referred to is released there, and its finaliser could run code that rebinds the switch`);
    const future = toks[k][0]?.t === 'from' && toks[k][1]?.t === '__future__';
    const docstring = k === 0 && toks[k].every((x) => x.kind === 'string') && s.prefixes.every((p) => !/[bft]/i.test(p));
    if (!future && !docstring) prologue = false;
  }
  const swap = bound.get(SWAP_VAR) ?? [];
  if (swap.length !== 1 || swap[0].how !== 'assignment') return unknown(`${SWAP_VAR} is bound more than once (lines ${swap.map((b) => b.line).join(', ')})`);
  for (const name of CONSTRUCTORS) if (bound.has(name)) return unknown(`line ${bound.get(name)![0].line} rebinds ${name}`);
  if ((bound.get('Chain')?.length ?? 0) > 1) return unknown(`Chain is bound more than once (lines ${bound.get('Chain')!.map((b) => b.line).join(', ')})`);

  const rhs = /^SWAP_DISABLED_CHAINS\s*(?::[^=]+)?=([\s\S]*)$/.exec(def.code)?.[1];
  const elements = rhs === undefined ? null : collectionElements(rhs);
  if (elements === null) return { zcashDisabled: null, line: def.line, reason: `${SWAP_VAR} is not a literal tuple/list/set of Chain members` };
  const names = elements.map((el) => /^Chain\s*\.\s*([A-Za-z_]\w*)$/.exec(el)?.[1] ?? null);
  // Enum member names are case-sensitive: gate3's member is Chain.ZCASH; Chain.Zcash would raise AttributeError.
  const variant = names.find((x) => x !== null && x !== 'ZCASH' && x.toUpperCase() === 'ZCASH');
  if (variant) return { zcashDisabled: null, line: def.line, reason: `${SWAP_VAR} names Chain.${variant}, not the member Chain.ZCASH (attribute names are case-sensitive)` };
  if (names.includes('ZCASH')) return { zcashDisabled: true, line: def.line, reason: null };
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
      // Python refuses a source file that is not valid UTF-8 (without a coding declaration); res.text() would replace
      // the bad bytes and let the rest read as a valid module. The byte order mark is kept: Python rejects it next to
      // a coding declaration other than utf-8, so the parser has to see it.
      let text: string | null;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await res.arrayBuffer());
      } catch {
        text = null;
      }
      const parsed =
        res.status === 404
          ? { zcashDisabled: null, line: null, reason: `${GATE3_FILE} not found (layout changed?)` }
          : text === null
            ? { zcashDisabled: null, line: null, reason: `${GATE3_FILE} is not valid UTF-8, so Python refuses to compile it; the value of ${SWAP_VAR} is not determined` }
            : parseGate3Switch(text);
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

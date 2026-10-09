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
  /** When the parsed bytes were last confirmed current, by a read or an unchanged verified listing. */
  verifiedAt?: string | null;
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
export const STUDY_RULES = 5;
/** Upper bound on raw study files fetched per run (the repository has ~125; an unchanged listing is not re-read). */
export const MAX_STUDY_FETCHES = 220;
/**
 * Zcash terms. Study level: a decoded feature name (enable/disable/forcing),
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

const SWAP_VAR = 'SWAP_DISABLED_CHAINS';

/*
 * gate3's app/api/swap/constants.py is a short constants module. Rather than interpret Python, the reader accepts a
 * definite answer only when the whole file is made of the few line shapes such a module uses, and answers unknown
 * (null) for anything else, naming the first line it does not accept. A file that only these shapes make up cannot
 * run code at import time, cannot rebind the switch, and decodes the same way in Python as here, so the literal the
 * switch is assigned is its final value. Accepted shapes:
 *   - printable ASCII only (plus tab and line breaks), so encoding declarations and invisible characters cannot
 *     change what Python reads; no "coding" declaration on line 1 or 2;
 *   - blank lines and comment lines;
 *   - an optional module docstring ("""...""" with no backslash or quote inside) before any other statement;
 *   - exactly one `from app.api.common.models import Chain`, before the switch;
 *   - simple constants `UPPER_CASE_NAME[: Annotation] = "text" | 'text' | number | True | False | None` (no escapes);
 *   - exactly one `SWAP_DISABLED_CHAINS[: Annotation] = <value>` (may span lines, with comments inside), where the
 *     value is (Chain.X, ...), [Chain.X, ...], {Chain.X, ...}, frozenset({...}) / frozenset([...]) / frozenset((...))
 *     / frozenset(), () or []. Every element must be a plain Chain.MEMBER; a parenthesised single element without a
 *     trailing comma is not a tuple and is not accepted; {} is a dict and is not accepted.
 * Annotations are restricted to known built-in types and the imported Chain; arbitrary names and subscriptions
 * are not interpreted, since their evaluation may fail or execute custom methods.
 */
/** Built-in types and the imported Chain, with the collection annotations used by the constants module. */
const ANNOTATION = String.raw`(?:int|float|bool|str|bytes|None|Chain|(?:frozenset|set|list|tuple)(?:\[Chain(?:, ?\.\.\.)?\])?)`;
const CONSTANT_LINE = new RegExp(String.raw`^([A-Z][A-Z0-9_]*)[ \t]*(?::[ \t]*(${ANNOTATION}))?[ \t]*=[ \t]*(?:"[^"\\\n]*"|'[^'\\\n]*'|-?(?:0|[1-9]\d{0,17})(?:\.\d{1,17})?|True|False|None)[ \t]*(?:#.*)?$`);
const SWITCH_HEAD = new RegExp(String.raw`^${SWAP_VAR}[ \t]*(?::[ \t]*${ANNOTATION})?[ \t]*=([\s\S]*)$`);
const CHAIN_IMPORT = /^from[ \t]+app\.api\.common\.models[ \t]+import[ \t]+Chain[ \t]*(?:#.*)?$/;
const MEMBER = /^Chain\.([A-Z][A-Z0-9_]*)$/;

/** The elements of an accepted collection value, or null when the value is not one of the accepted shapes. */
function switchElements(value: string): string[] | null {
  // Comments inside a multi-line value carry no meaning; strings are not allowed in the value at all.
  if (/["'\\]/.test(value)) return null;
  const v = value.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  let inner: string;
  let tuple = false;
  const fz = /^frozenset ?\((.*)\)$/.exec(v);
  if (fz) {
    const arg = fz[1].trim();
    if (arg === '') return [];
    const m = /^([\[{(])(.*)([\]})])$/.exec(arg);
    if (!m || '[{('.indexOf(m[1]) !== ']})'.indexOf(m[3])) return null;
    if (m[1] === '{' && m[2].trim() === '') return null; // frozenset({}) is a dict argument
    inner = m[2];
    tuple = m[1] === '(';
  } else {
    const m = /^([\[{(])(.*)([\]})])$/.exec(v);
    if (!m || '[{('.indexOf(m[1]) !== ']})'.indexOf(m[3])) return null;
    if (m[1] === '{' && m[2].trim() === '') return null; // {} is a dict
    inner = m[2];
    tuple = m[1] === '(';
  }
  if (/[()[\]{}]/.test(inner)) return null; // nested brackets: not a flat collection of members
  const trimmed = inner.trim();
  if (trimmed === '') return [];
  const trailing = trimmed.endsWith(',');
  const parts = (trailing ? trimmed.slice(0, -1) : trimmed).split(',').map((p) => p.trim());
  if (parts.some((p) => !MEMBER.test(p))) return null;
  // (Chain.X) without a trailing comma is a parenthesised expression, not a tuple (also as frozenset's argument).
  if (tuple && parts.length === 1 && !trailing) return null;
  return parts;
}

/**
 * Whether gate3's module-level SWAP_DISABLED_CHAINS contains Chain.ZCASH: true/false when the whole file is made of
 * the accepted line shapes above, otherwise null with the first line that is not accepted. `src` is the decoded file.
 */
export function parseGate3Switch(src: string): { zcashDisabled: boolean | null; line: number | null; reason: string | null } {
  const unknown = (line: number | null, why: string) => ({ zcashDisabled: null, line, reason: `${why}; only a plain constants module is read, so the value of ${SWAP_VAR} is not determined` });
  // One leading UTF-8 byte order mark is read by Python too (as utf-8-sig) unless a coding declaration follows it.
  if (src.startsWith('\uFEFF')) {
    src = src.slice(1);
    if (src.replace(/\r\n?/g, '\n').split('\n', 2).some((l) => /^[ \t]*#.*coding[:=]/.test(l))) return unknown(1, 'the file starts with a byte order mark and declares a source encoding');
  }
  if (/[^\t\n\r\x20-\x7e]/.test(src)) {
    const at = src.search(/[^\t\n\r\x20-\x7e]/);
    return unknown(src.slice(0, at).split('\n').length, 'the file contains a character outside printable ASCII');
  }
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  if (lines.slice(0, 2).some((l) => /^[ \t]*#.*coding[:=]/.test(l))) return unknown(1, 'the file declares a source encoding');
  let chainImported = false;
  let defLine: number | null = null;
  let elements: string[] | null = null;
  let seenStatement = false;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    if (!seenStatement && line.startsWith('"""')) {
      // Module docstring: up to the closing """ with no backslash or quote character in between.
      let text = line.slice(3);
      let j = i;
      while (!text.includes('"""') && j + 1 < lines.length) text += '\n' + lines[++j];
      const end = text.indexOf('"""');
      if (end < 0 || /["\\]/.test(text.slice(0, end)) || text.slice(end + 3).trim() !== '') return unknown(n, `line ${n} is a docstring this reader does not accept`);
      i = j;
      seenStatement = true;
      continue;
    }
    seenStatement = true;
    if (/^[ \t]/.test(line)) return unknown(n, `line ${n} is indented`);
    if (CHAIN_IMPORT.test(line)) {
      if (chainImported || defLine !== null) return unknown(n, `line ${n} imports Chain again or after the switch`);
      chainImported = true;
      continue;
    }
    const c = CONSTANT_LINE.exec(line);
    if (c) {
      if (c[2]?.includes('Chain') && !chainImported) return unknown(n, `line ${n} uses Chain in an annotation before it is imported`);
      if (c[1] === SWAP_VAR) return unknown(n, `line ${n} binds ${SWAP_VAR} to something other than a collection of Chain members`);
      continue;
    }
    const head = SWITCH_HEAD.exec(line);
    if (head) {
      if (defLine !== null) return unknown(n, `${SWAP_VAR} is assigned more than once (lines ${defLine}, ${n})`);
      if (!chainImported) return unknown(n, `${SWAP_VAR} is assigned before Chain is imported`);
      // Collect a multi-line value until its brackets balance (comments may follow on each line).
      let value = head[1];
      let j = i;
      const depth = (s: string) => {
        const t = s.replace(/#[^\n]*/g, '');
        return (t.match(/[([{]/g)?.length ?? 0) - (t.match(/[)\]}]/g)?.length ?? 0);
      };
      while (depth(value) > 0 && j + 1 < lines.length) value += '\n' + lines[++j];
      if (depth(value) !== 0) return unknown(n, `the value of ${SWAP_VAR} does not close`);
      const els = switchElements(value);
      if (els === null) return unknown(n, `${SWAP_VAR} (line ${n}) is not a literal collection of plain Chain members`);
      defLine = n;
      elements = els;
      i = j;
      continue;
    }
    return unknown(n, `line ${n} is not one of the statement shapes this reader accepts`);
  }
  if (defLine === null || elements === null) return { zcashDisabled: null, line: null, reason: `${SWAP_VAR} assignment not found` };
  return { zcashDisabled: elements.includes('Chain.ZCASH'), line: defLine, reason: null };
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

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const stringList = (v: unknown): boolean => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

/** Validate fields this reader uses before interpreting missing or malformed settings as an empty study. */
function studyShapeProblem(st: unknown): string | null {
  if (!record(st)) return 'study is not an object';
  if (typeof st.name !== 'string' || !st.name.trim()) return 'study name is not a non-empty string';
  if (!Array.isArray(st.experiment)) return `${st.name}: experiment is not a list`;
  for (const [i, e] of st.experiment.entries()) {
    const at = `${st.name}: experiment ${i + 1}`;
    if (!record(e)) return `${at} is not an object`;
    if (typeof e.name !== 'string' || !e.name.trim()) return `${at} name is not a non-empty string`;
    if (typeof e.probability_weight !== 'number' || !Number.isSafeInteger(e.probability_weight) || e.probability_weight < 0) return `${at} probability_weight is not a non-negative integer`;
    if (e.feature_association !== undefined) {
      if (!record(e.feature_association)) return `${at} feature_association is not an object`;
      for (const key of ['enable_feature', 'disable_feature', 'forcing_feature_on', 'forcing_feature_off']) {
        const v = e.feature_association[key];
        if (v !== undefined && !stringList(v)) return `${at} ${key} is not a string or a list of strings`;
      }
    }
    if (e.param !== undefined) {
      if (!Array.isArray(e.param)) return `${at} param is not a list`;
      for (const p of e.param) if (!record(p) || typeof p.name !== 'string' || typeof p.value !== 'string') return `${at} parameter name/value is not a string`;
    }
  }
  if (st.filter !== undefined && st.filter !== null) {
    if (!record(st.filter)) return `${st.name}: filter is not an object`;
    for (const key of ['platform', 'channel']) {
      const v = st.filter[key];
      if (v !== undefined && v !== null && !stringList(v)) return `${st.name}: filter ${key} is not a string or a list of strings`;
    }
    for (const key of ['min_version', 'max_version']) {
      const v = st.filter[key];
      if (v !== undefined && v !== null && (typeof v !== 'string' || !/^(?:\d+|\*)(?:\.(?:\d+|\*)){0,3}$/.test(v))) return `${st.name}: filter ${key} is not a version range`;
    }
  }
  return null;
}

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
  const problem = studyShapeProblem(st);
  if (problem) throw new Error(`unsupported study shape: ${problem}`);
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
    verifiedAt: now,
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
    const carried: { since: string; what: string }[] = [];
    const markCarried = (what: string, since: string | null | undefined) => {
      if (since && Number.isFinite(Date.parse(since))) carried.push({ since, what });
    };
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
        if (lastDetermined) markCarried('gate3 swap routing', lastDetermined.checkedAt);
        limitations.push(`gate3 at ${gsha.slice(0, 8)}: ${parsed.reason}; Zcash routing state is unknown${lastDetermined ? ` (last determined ${lastDetermined.zcashDisabled ? 'disabled' : 'not disabled'} at ${lastDetermined.commitSha.slice(0, 8)}, ${lastDetermined.checkedAt})` : ''}`);
      }
    } catch (err) {
      partial = true;
      if (gate3) markCarried('gate3 repository reading', gate3.checkedAt ?? prevReadAt);
      if (gate3?.lastDetermined) markCarried('gate3 swap routing', gate3.lastDetermined.checkedAt);
      limitations.push(`brave/gate3 could not be re-read (${errText(err)}); ${gate3 ? `keeping the value read at ${gate3.checkedAt}` : 'no earlier value'}`);
    }

    // ---- brave-variations studies ----
    const versionsData = ctx.get<{ current?: ChannelVersion[] }>('brave-versions')?.data;
    const relData = ctx.get<ReleasesData>('brave-releases')?.data ?? null;
    const builds = studyBuilds(Array.isArray(versionsData?.current) ? versionsData!.current : null, relData);
    // Earlier data can hold studies selected by older, broader rules (e.g. any Brave Wallet feature); those never
    // touched Zcash and are not carried, even while brave-variations cannot be re-read.
    const prevAll = Array.isArray(prev?.studies) ? prev!.studies : [];
    const prevStudies = prevAll.filter(studyInfoTouchesZcash).map((s) => {
      const readAt = s.readAt ?? prev?.studiesReadAt ?? prevReadAt;
      // Legacy records were confirmed by a complete verified listing unless their file was still pending.
      const listingVerified = prev?.studiesDigest && !prev.studyPending?.includes(s.file) ? prev.studiesReadAt : null;
      return { ...s, readAt, verifiedAt: s.verifiedAt ?? listingVerified ?? readAt };
    });
    const notZcash = uniqStr(prevAll.filter((s) => !studyInfoTouchesZcash(s)).map((s) => s.name));
    if (notZcash.length) limitations.push(`${notZcash.length} earlier stud${notZcash.length === 1 ? 'y was' : 'ies were'} dropped because no cohort sets a Zcash/Ironwood feature or parameter: ${notZcash.slice(0, 4).join(', ')}`);
    const prevByFile = new Map<string, StudyInfo[]>();
    for (const s of prevStudies) prevByFile.set(s.file, [...(prevByFile.get(s.file) ?? []), s]);
    const carry = (file: string, verified = false) => (prevByFile.get(file) ?? []).map((s) => ({ ...refreshApplicability(s, builds, ctx.now), ...(verified ? { verifiedAt: ctx.now } : {}) }));

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
          next.push(...carry(name, true));
          continue;
        }
        // Keep the file's earlier studies and retry it next run.
        const keep = (problem: string | null) => {
          if (problem) failed.push(`${name} (${problem})`);
          pending.push(name);
          next.push(...carry(name));
          for (const s of prevByFile.get(name) ?? []) markCarried(`studies in ${name}`, s.verifiedAt ?? s.readAt);
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
          // Only a verified file with no prior Zcash studies and no escapes can be ruled out from raw wording.
          if (f.sha && !prevByFile.has(name) && !RELEVANT_TEXT.test(text) && !text.includes('\\')) unparsedIrrelevant.push(name);
          else keep(`could not parse: ${parseError}`);
          continue;
        }
        const shapeProblem = parsed.map(studyShapeProblem).find((p) => p !== null);
        if (shapeProblem) {
          keep(`unsupported study shape: ${shapeProblem}`);
          continue;
        }
        next.push(...parsed.filter(isRelevantStudy).map((st) => toStudyInfo(st, name, vsha, builds, ctx.now)));
      }
      if (truncatedListing) {
        const listed = new Set(files.map((f) => f.name));
        for (const [file, old] of prevByFile) if (!listed.has(file)) {
          next.push(...carry(file));
          for (const s of old) markCarried(`studies in ${file}`, s.verifiedAt ?? s.readAt);
        }
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
      markCarried('brave-variations studies listing', studiesReadAt ?? prevReadAt);
      for (const s of prevStudies) if (studyPending.includes(s.file)) markCarried(`studies in ${s.file}`, s.verifiedAt ?? s.readAt);
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
    const oldest = carried.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
    const carriedWhat = uniqStr(carried.map((c) => c.what));
    return { data, limitations, partial, itemCount: studies.length + (gate3 ? 1 : 0), ...(oldest ? { staleSince: oldest.since, staleWhat: carriedWhat.slice(0, 4).join(', ') + (carriedWhat.length > 4 ? ` and ${carriedWhat.length - 4} more study files` : '') } : {}) };
  },
};

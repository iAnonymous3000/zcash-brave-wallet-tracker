// Public server-side signals that change Zcash behaviour without a browser release:
//  - brave/gate3 (swap/bridge routing backend): whether Zcash is in SWAP_DISABLED_CHAINS
//  - brave/brave-variations (Griffin field trials): studies touching Zcash features/params
// Both are read from the public repositories; the deployed services could differ from
// the repository state, which the site states explicitly.
//
// The two components are independent: when one cannot be re-read, its last good value
// is kept (with its own read time) and the source is reported partial, so an outage
// never reads as "no study" or "switch not set".

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
  /** Desktop only: the desktop OS families the platform filter admits, when it is a subset of Windows/macOS/Linux. */
  desktopOs?: string[];
}

export interface StudyInfo {
  file: string;
  name: string;
  /**
   * Settings shared by every enrolled cohort (experiments with weight > 0). A feature or parameter
   * that differs between cohorts is listed in `mixed` and attributed per cohort in `experiments`.
   */
  features: { enable: string[]; disable: string[] };
  params: Record<string, string>;
  minVersion: string | null;
  maxVersion: string | null;
  channels: string[];
  platforms: string[];
  probability: number | null;
  /** Chromium-based Brave version the study's range is compared with, per current build ("155.1.97.56"). */
  appliesTo: StudyApplicability[];
  url: string;
  /** Every experiment (cohort) with its weight and own settings. */
  experiments?: StudyExperiment[];
  /** Features/params whose setting differs between enrolled cohorts (so no single study-wide value exists). */
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

export interface StudyFileState {
  /** Git blob SHA from the directory listing (null when the listing did not provide one). */
  sha: string | null;
  readAt: string | null;
  /** Whether the file contains studies touching Zcash. */
  relevant: boolean;
  /** Set when the last attempt failed; the file is re-read next run. */
  error?: string;
}

export interface ServicesData {
  gate3: Gate3Info | null;
  studies: StudyInfo[];
  studiesCommit: string | null;
  /** When the brave-variations listing was last read successfully (studies may be older if carried over). */
  studiesReadAt?: string | null;
  /** Per-file read state, so unchanged files are not refetched and failed ones are retried. */
  studyFiles?: Record<string, StudyFileState>;
  /** Version of the study selection/parsing rules the per-file cache was built with. */
  studyRules?: number;
}

const GATE3_FILE = 'app/api/swap/constants.py';
/** Bump when relevance or parsing rules change, so cached per-file verdicts are recomputed. */
export const STUDY_RULES = 2;
/** Upper bound on raw study files fetched per run (the repository has ~125; unchanged files are cached by blob SHA). */
export const MAX_STUDY_FETCHES = 220;
/** File-level content test: the file must mention Zcash/Ironwood somewhere. */
const RELEVANT_TEXT = /zcash|ironwood/i;
const RELEVANT_NAME = /zcash|ironwood|wallet/i;

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
  const flush = () => {
    if (buf.trim()) out.push({ code: buf.trim(), line: startLine, indent });
    buf = '';
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

/**
 * Whether gate3's module-level SWAP_DISABLED_CHAINS contains Chain.ZCASH.
 * true/false only for a single literal assignment whose relevant elements are all Chain.X;
 * null (unknown) for anything else (computed values, reassignment, conditional definitions).
 */
export function parseGate3Switch(src: string): { zcashDisabled: boolean | null; line: number | null; reason: string | null } {
  const stmts = pythonStatements(src);
  const assign = new RegExp(`^${SWAP_VAR}\\s*(?::[^=]+)?=(?!=)([\\s\\S]*)$`);
  const defs = stmts.filter((s) => assign.test(s.code));
  const mutation = new RegExp(
    [
      `\\b${SWAP_VAR}\\s*(?:\\|=|-=|&=|\\^=|\\+=|:=)`,
      `\\b${SWAP_VAR}\\s*\\.\\s*(?:add|update|discard|remove|clear|pop|append|extend|insert|\\w+_update)\\s*\\(`,
      `\\bdel\\s+${SWAP_VAR}\\b`,
      `\\b(?:as|for|global)\\s+${SWAP_VAR}\\b`,
      `^(?:[A-Za-z_]\\w*\\s*,\\s*)+${SWAP_VAR}\\s*(?:,[\\w\\s,]*)?=(?!=)`,
      `^${SWAP_VAR}\\s*,[\\w\\s,]*=(?!=)`,
      `=\\s*${SWAP_VAR}\\s*=(?!=)`,
    ].join('|'),
  );
  const others = stmts.filter((s) => !defs.includes(s) && mutation.test(s.code));
  if (!defs.length) return { zcashDisabled: null, line: null, reason: `${SWAP_VAR} assignment not found` };
  const top = defs.filter((d) => d.indent === 0);
  if (!top.length) return { zcashDisabled: null, line: defs[0].line, reason: `${SWAP_VAR} is only assigned inside a block (conditional or nested definition)` };
  if (defs.length > 1 || others.length) return { zcashDisabled: null, line: top[0].line, reason: `${SWAP_VAR} is assigned or modified more than once; its final value is not determined statically` };
  const def = top[0];
  const rhs = assign.exec(def.code)![1];
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
}

const PLATFORM_NAME: Record<Platform, string> = { desktop: 'Desktop', android: 'Android', ios: 'iOS' };
const DESKTOP_FAMILIES = ['WINDOWS', 'MAC', 'LINUX'];
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

const normCode = (v: unknown) => String(v).toUpperCase().replace(/^(PLATFORM|CHANNEL)_/, '');
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === null ? [] : [String(v)]);

function dateValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000; // Chromium: seconds since epoch
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return Number(v) * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Evaluate a study filter against one build. null = cannot be determined from public data. */
export function evaluateStudyFilter(filter: Record<string, unknown> | null | undefined, b: StudyBuild, now: string): { applies: boolean | null; reason: string; desktopOs?: string[] } {
  const f = filter ?? {};
  const excluded: string[] = [];
  const unknown: string[] = [];
  let desktopOs: string[] | undefined;

  const platforms = asList(f.platform).map(normCode);
  if (platforms.length) {
    const hit = PLATFORM_CODES[b.platform].filter((p) => platforms.includes(p));
    if (!hit.length) excluded.push(`platform filter (${platforms.join(', ')}) excludes ${PLATFORM_NAME[b.platform]}`);
    else if (b.platform === 'desktop' && hit.length < DESKTOP_FAMILIES.length) desktopOs = hit;
  }
  const channels = asList(f.channel).map(normCode);
  if (channels.length && !CHANNEL_CODES[b.channel].some((c) => channels.includes(c))) excluded.push(`channel filter (${channels.join(', ')}) excludes ${b.channel}`);

  const min = f.min_version === undefined || f.min_version === null ? null : String(f.min_version);
  const max = f.max_version === undefined || f.max_version === null ? null : String(f.max_version);
  if (min || max) {
    if (b.chromiumMajor === null || !/^\d+\.\d+\.\d+$/.test(b.version)) unknown.push(`the Chromium-based version of ${b.version} is not known, so the version range ${min ?? 'any'} – ${max ?? 'any'} cannot be checked`);
    else {
      const full = `${b.chromiumMajor}.${b.version}`;
      if (!inStudyRange(full, min, max)) excluded.push(`${full} is outside the version range ${min ?? 'any'} – ${max ?? 'any'}`);
    }
  }
  const nowMs = Date.parse(now);
  for (const [key, cmp] of [['start_date', 1], ['end_date', -1]] as const) {
    if (f[key] === undefined || f[key] === null) continue;
    const t = dateValue(f[key]);
    if (t === null || !Number.isFinite(nowMs)) unknown.push(`${key} ${String(f[key])} could not be interpreted`);
    else if (cmp === 1 ? nowMs < t : nowMs > t) excluded.push(`${key} ${new Date(t).toISOString()} ${cmp === 1 ? 'is in the future' : 'has passed'}`);
  }
  for (const key of Object.keys(f)) {
    if (BUILD_KEYS.has(key) || CLIENT_KEYS.has(key)) continue;
    unknown.push(`filter key "${key}" is not evaluated`);
  }
  if (excluded.length) return { applies: false, reason: excluded.join('; ') };
  if (unknown.length) return { applies: null, reason: unknown.join('; ') };
  return { applies: true, reason: desktopOs ? `admitted on ${desktopOs.join(', ')} only among desktop OSes` : 'platform, channel and version filters admit this build', ...(desktopOs ? { desktopOs } : {}) };
}

/** Client-level conditions of a filter, as readable strings. */
export function studyConditions(filter: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(filter ?? {})
    .filter(([k]) => CLIENT_KEYS.has(k))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
}

/** Current builds per platform × channel: versions.brave.com pointers, GitHub release names as a labelled fallback. */
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
      let version: string | null = cv?.version ?? null;
      let fallback = false;
      if (!version) {
        if (platform === 'ios' && channel === 'release') continue; // App Store build is not published; no fallback
        version = latest.find((l) => l.channel === channel)?.version ?? null;
        fallback = Boolean(version);
      }
      if (!version) continue;
      const major = chromiumOf(version);
      out.push({ platform, channel, version, chromiumMajor: major, label: `${PLATFORM_NAME[platform]} ${channel} ${version}${major !== null && /^\d+\.\d+\.\d+$/.test(version) ? ` (${major}.${version})` : ''}${fallback ? ' [GitHub release; version pointer unavailable]' : ''}` });
    }
  }
  return out;
}

function applicability(filter: Record<string, unknown> | undefined, builds: StudyBuild[], now: string): Pick<StudyInfo, 'appliesTo' | 'appliesUnknown'> {
  const appliesTo: StudyApplicability[] = [];
  const appliesUnknown: NonNullable<StudyInfo['appliesUnknown']> = [];
  for (const b of builds) {
    const r = evaluateStudyFilter(filter, b, now);
    if (r.applies === null) appliesUnknown.push({ build: b.label, platform: b.platform, channel: b.channel, version: b.version, reason: r.reason });
    else appliesTo.push({ build: b.label, applies: r.applies, platform: b.platform, channel: b.channel, version: b.version, reason: r.reason, ...(r.desktopOs ? { desktopOs: r.desktopOs } : {}) });
  }
  return appliesUnknown.length ? { appliesTo, appliesUnknown } : { appliesTo };
}

/** Recompute applicability of a stored study for the current builds (keeps the old answer when it cannot be recomputed). */
function refreshApplicability(st: StudyInfo, builds: StudyBuild[], now: string): StudyInfo {
  if (!st.filter || !builds.length) return st;
  const { appliesUnknown: _stale, ...rest } = st;
  return { ...rest, ...applicability(st.filter, builds, now) };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).map(String) : []);

/** Whether a parsed study touches Zcash/Ironwood/Wallet features or parameters in any experiment. */
export function isRelevantStudy(st: any): boolean {
  if (!st || typeof st !== 'object') return false;
  for (const e of Array.isArray(st.experiment) ? st.experiment : []) {
    const fa = e?.feature_association ?? {};
    const names = [...strList(fa.enable_feature), ...strList(fa.disable_feature), ...strList(fa.forcing_feature_on), ...strList(fa.forcing_feature_off)];
    for (const p of Array.isArray(e?.param) ? e.param : []) {
      names.push(String(p?.name ?? ''));
      if (RELEVANT_TEXT.test(String(p?.value ?? ''))) return true;
    }
    if (names.some((x) => RELEVANT_NAME.test(x))) return true;
  }
  return false;
}

/** Turn one parsed study into StudyInfo, keeping each cohort separately. */
export function toStudyInfo(st: any, file: string, commit: string, builds: StudyBuild[], now: string): StudyInfo {
  const exps: any[] = Array.isArray(st.experiment) ? st.experiment : [];
  const total = exps.reduce((s, e) => s + (Number(e?.probability_weight) || 0), 0);
  const experiments: StudyExperiment[] = exps.map((e) => {
    const weight = Number(e?.probability_weight) || 0;
    const params: Record<string, string> = {};
    for (const p of Array.isArray(e?.param) ? e.param : []) if (p?.name !== undefined) params[String(p.name)] = String(p.value ?? '');
    return {
      name: String(e?.name ?? ''),
      weight,
      share: total > 0 ? Math.round((weight / total) * 10000) / 100 : null,
      enable: strList(e?.feature_association?.enable_feature),
      disable: strList(e?.feature_association?.disable_feature),
      params,
    };
  });
  const active = experiments.filter((e) => e.weight > 0);
  // Study-wide settings are those every enrolled cohort shares; the rest are cohort-dependent.
  const allFeatures = [...new Set(active.flatMap((e) => [...e.enable, ...e.disable]))];
  const enable = allFeatures.filter((f) => active.every((e) => e.enable.includes(f) && !e.disable.includes(f)));
  const disable = allFeatures.filter((f) => active.every((e) => e.disable.includes(f) && !e.enable.includes(f)));
  const mixedFeatures = allFeatures.filter((f) => !enable.includes(f) && !disable.includes(f));
  const params: Record<string, string> = {};
  const mixedParams: string[] = [];
  for (const name of [...new Set(active.flatMap((e) => Object.keys(e.params)))]) {
    const values = active.map((e) => (Object.prototype.hasOwnProperty.call(e.params, name) ? e.params[name] : undefined));
    if (values.every((v) => v !== undefined && v === values[0])) params[name] = values[0]!;
    else mixedParams.push(name);
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
    const prevStudies = (prev?.studies ?? []).map((s) => ({ ...s, readAt: s.readAt ?? prevReadAt }));
    const prevByFile = new Map<string, StudyInfo[]>();
    for (const s of prevStudies) prevByFile.set(s.file, [...(prevByFile.get(s.file) ?? []), s]);
    const carry = (file: string) => (prevByFile.get(file) ?? []).map((s) => refreshApplicability(s, builds, ctx.now));

    let studies: StudyInfo[] = prevStudies.map((s) => refreshApplicability(s, builds, ctx.now));
    let studiesCommit = prev?.studiesCommit ?? null;
    let studiesReadAt = prev?.studiesReadAt ?? (prev ? prevReadAt : null);
    let studyFiles: Record<string, StudyFileState> | undefined = prev?.studyFiles;
    let studyRules = prev?.studyRules;
    let variationsFresh = false;
    try {
      const vsha = await ctx.gh.commitSha('brave/brave-variations', 'main');
      if (!vsha) throw new Error('main commit could not be resolved');
      const { data: listing } = await ctx.gh.rest<any[]>(`/repos/brave/brave-variations/contents/studies?ref=${vsha}`);
      if (!Array.isArray(listing)) throw new Error('studies/ listing is not a directory listing');
      variationsFresh = true;
      const cache = prev?.studyRules === STUDY_RULES ? (prev?.studyFiles ?? {}) : {};
      const nextFiles: Record<string, StudyFileState> = {};
      const next: StudyInfo[] = [];
      const entries = listing.filter((x) => x && typeof x.name === 'string');
      const dirs = entries.filter((x) => x.type === 'dir');
      const files = entries.filter((x) => x.type !== 'dir' && /\.json5?$/i.test(x.name));
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
      let fetched = 0;
      const failed: string[] = [];
      const deferred: string[] = [];
      for (const f of files) {
        const name: string = f.name;
        const sha: string | null = typeof f.sha === 'string' ? f.sha : null;
        const cached = cache[name];
        const before = prevByFile.get(name) ?? [];
        const reusable = Boolean(cached && !cached.error && sha && cached.sha === sha && (!cached.relevant || (before.length > 0 && before.every((s) => s.filter && s.experiments))));
        if (reusable) {
          nextFiles[name] = cached!;
          if (cached!.relevant) next.push(...carry(name));
          continue;
        }
        if (fetched >= MAX_STUDY_FETCHES) {
          deferred.push(name);
          next.push(...carry(name));
          if (cached) nextFiles[name] = { ...cached, error: 'deferred (per-run cap)' };
          continue;
        }
        fetched += 1;
        let text: string;
        try {
          const raw = await ctx.http.request(`https://raw.githubusercontent.com/brave/brave-variations/${vsha}/studies/${encodeURIComponent(name)}`, { scope: 'raw.githubusercontent.com' });
          text = await raw.text();
        } catch (err) {
          failed.push(`${name} (${errText(err)})`);
          next.push(...carry(name));
          nextFiles[name] = { sha: null, readAt: cached?.readAt ?? null, relevant: before.length > 0 || Boolean(cached?.relevant), error: errText(err) };
          continue;
        }
        if (!RELEVANT_TEXT.test(text)) {
          nextFiles[name] = { sha, readAt: ctx.now, relevant: false };
          continue;
        }
        let parsed: unknown;
        try {
          parsed = parseJson5(text);
          if (!Array.isArray(parsed)) throw new Error('top level is not a list of studies');
        } catch (err) {
          failed.push(`${name} (could not parse: ${errText(err)})`);
          next.push(...carry(name));
          nextFiles[name] = { sha: null, readAt: cached?.readAt ?? null, relevant: true, error: `parse: ${errText(err)}` };
          continue;
        }
        const found = (parsed as any[]).filter(isRelevantStudy).map((st) => toStudyInfo(st, name, vsha, builds, ctx.now));
        nextFiles[name] = { sha, readAt: ctx.now, relevant: found.length > 0 };
        next.push(...found);
      }
      if (truncatedListing) {
        const listed = new Set(files.map((f) => f.name));
        for (const [file] of prevByFile) if (!listed.has(file)) next.push(...carry(file));
      }
      if (failed.length) {
        partial = true;
        limitations.push(`${failed.length} study file(s) could not be read or parsed; their earlier studies are kept: ${failed.slice(0, 4).join('; ')}`);
      }
      if (deferred.length) {
        partial = true;
        limitations.push(`${deferred.length} study file(s) deferred by the per-run cap of ${MAX_STUDY_FETCHES}; their earlier studies are kept`);
      }
      studies = next;
      studiesCommit = vsha;
      studiesReadAt = ctx.now;
      studyFiles = nextFiles;
      studyRules = STUDY_RULES;
    } catch (err) {
      partial = true;
      limitations.push(`brave/brave-variations could not be re-read (${errText(err)}); ${prevStudies.length ? `keeping ${prevStudies.length} stud${prevStudies.length === 1 ? 'y' : 'ies'} read at ${studiesReadAt ?? 'an earlier run'}` : 'no earlier studies to show'}`);
    }

    if (!gate3Fresh && !variationsFresh) throw new Error('neither brave/gate3 nor brave/brave-variations could be read');
    const unknownBuilds = studies.filter((s) => s.appliesUnknown?.length).length;
    if (unknownBuilds) limitations.push(`${unknownBuilds} stud${unknownBuilds === 1 ? 'y has' : 'ies have'} builds whose eligibility cannot be determined from public data`);
    const data: ServicesData = { gate3, studies, studiesCommit, studiesReadAt: studiesReadAt ?? null, ...(studyFiles ? { studyFiles } : {}), ...(studyRules !== undefined ? { studyRules } : {}) };
    return { data, limitations, partial, itemCount: studies.length + (gate3 ? 1 : 0) };
  },
};

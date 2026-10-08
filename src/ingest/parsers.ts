// Pure, deterministic parsers for upstream formats. No I/O here so every rule
// is unit-testable against captured fixtures.

import type { Channel, ChangelogEntry, FlagValue, Platform } from '../lib/types.ts';
import { extractRefs, plainExcerpt } from '../lib/util.ts';

// ---------------------------------------------------------------------------
// Brave GitHub release names
// ---------------------------------------------------------------------------

/**
 * "Release v1.97.56 (Chromium 155.0.8059.40)" -> release
 * "Beta v1.98.52 (Chromium ...)"               -> beta
 * "Nightly v1.99.25 (Chromium ...)"            -> nightly
 * The GitHub `prerelease` flag is NOT reliable for Brave (nightlies are often
 * published with prerelease=false), so the channel comes from the name only.
 */
export function parseReleaseName(name: string | null | undefined): { channel: Channel | null; version: string | null; chromium: string | null } {
  const s = (name ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(Release|Beta|Nightly|Dev)\s+v?(\d+\.\d+\.\d+)/i);
  const chromium = s.match(/Chromium[:\s]+(\d+\.\d+\.\d+\.\d+)/i)?.[1] ?? null;
  if (!m) return { channel: null, version: s.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null, chromium };
  const word = m[1].toLowerCase();
  const channel: Channel | null = word === 'release' ? 'release' : word === 'beta' ? 'beta' : word === 'nightly' ? 'nightly' : null;
  return { channel, version: m[2], chromium };
}

/** Map release asset file names to platforms. Presence of an asset does not imply feature parity. */
export function assetPlatforms(assetNames: string[]): string[] {
  const out = new Set<string>();
  for (const n of assetNames) {
    const s = n.toLowerCase();
    if (/\.(apk|aab)$/.test(s) || /android/.test(s)) out.add('android');
    if (/brave-core-ios|\.ipa$|ios/.test(s)) out.add('ios');
    if (/\.(dmg|pkg)$/.test(s) || /macos|darwin/.test(s)) out.add('macos');
    if (/\.(exe|msi)$/.test(s) || /win(32|64)|windows/.test(s)) out.add('windows');
    if (/\.(deb|rpm)$/.test(s) || /linux/.test(s)) out.add('linux');
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Platform changelogs (CHANGELOG_DESKTOP.md, CHANGELOG_ANDROID.md, CHANGELOG_iOS.md, archive)
// ---------------------------------------------------------------------------

export const ZCASH_TEXT = /\b(z\s?cash|zec|ironwood|orchard|lightwalletd|zaino|unified address(es)?|sapling|shielded|unshield\w*|deshield\w*)\b/i;

export function parseChangelog(text: string, opts: { platform: Platform; file: string; commitSha: string; repo?: string }): ChangelogEntry[] {
  const repo = opts.repo ?? 'brave/brave-browser';
  const lines = text.split('\n');
  const out: ChangelogEntry[] = [];
  let version: string | null = null;
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/);
    if (h2) {
      version = h2[1];
      section = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      section = h3[1].trim();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!bullet || !version) continue;
    const md = bullet[1];
    const issueRefs = extractRefs(md).filter((r) => r.startsWith(`${repo}#`));
    const text = plainExcerpt(md, 600);
    out.push({
      platform: opts.platform,
      version,
      section,
      text,
      issueRefs,
      line: i + 1,
      file: opts.file,
      commitSha: opts.commitSha,
      permalink: `https://github.com/${repo}/blob/${opts.commitSha}/${opts.file}#L${i + 1}`,
      zcashRelated: ZCASH_TEXT.test(text),
    });
  }
  return out;
}

/** Ordered list of versions as they appear (newest first in Brave's files). */
export function changelogVersions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/gm)) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Chromium-style feature flags (components/brave_wallet/common/features.cc)
// ---------------------------------------------------------------------------

const PLATFORM_DEFINES: Record<Platform, Record<string, boolean>> = {
  // Desktop is evaluated as Windows/macOS/Linux; differences between desktop OSes are flagged as null.
  desktop: { IS_ANDROID: false, IS_IOS: false, IS_CHROMEOS: false },
  android: { IS_ANDROID: true, IS_IOS: false, IS_WIN: false, IS_MAC: false, IS_LINUX: false, IS_CHROMEOS: false },
  ios: { IS_ANDROID: false, IS_IOS: true, IS_WIN: false, IS_MAC: false, IS_LINUX: false, IS_CHROMEOS: false },
};

/**
 * Evaluate a preprocessor condition (BUILDFLAG(...), defined(...), !, &&, ||, parentheses)
 * for a platform with a small recursive-descent parser (no eval).
 * Returns null when the result depends on macros we cannot resolve.
 */
export function evalCondition(expr: string, platform: Platform): boolean | null {
  const defs = PLATFORM_DEFINES[platform];
  const src = expr.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  // Tokens: atoms (resolved to true/false/unknown), operators, parens.
  type Tok = { t: 'atom'; v: boolean | null } | { t: 'op'; v: '!' | '&&' | '||' | '(' | ')' };
  const toks: Tok[] = [];
  const re = /\s*(BUILDFLAG\(\s*(\w+)\s*\)|defined\s*\(\s*\w+\s*\)|&&|\|\||!|\(|\)|true|false|0|1)/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return null;
    pos = re.lastIndex;
    const tok = m[1];
    if (tok.startsWith('BUILDFLAG')) toks.push({ t: 'atom', v: m[2] in defs ? defs[m[2]] : null });
    else if (tok.startsWith('defined')) toks.push({ t: 'atom', v: null });
    else if (tok === 'true' || tok === '1') toks.push({ t: 'atom', v: true });
    else if (tok === 'false' || tok === '0') toks.push({ t: 'atom', v: false });
    else toks.push({ t: 'op', v: tok as '!' | '&&' | '||' | '(' | ')' });
  }
  let i = 0;
  const peek = () => toks[i];
  // Three-valued logic: null = unknown.
  const or = (): boolean | null => {
    let v = and();
    while (peek()?.t === 'op' && peek()!.v === '||') {
      i++;
      const r = and();
      v = v === true || r === true ? true : v === null || r === null ? null : false;
    }
    return v;
  };
  const and = (): boolean | null => {
    let v = not();
    while (peek()?.t === 'op' && peek()!.v === '&&') {
      i++;
      const r = not();
      v = v === false || r === false ? false : v === null || r === null ? null : true;
    }
    return v;
  };
  const not = (): boolean | null => {
    const t = peek();
    if (t?.t === 'op' && t.v === '!') {
      i++;
      const v = not();
      return v === null ? null : !v;
    }
    return atom();
  };
  const atom = (): boolean | null => {
    const t = toks[i++];
    if (!t) throw new Error('unexpected end');
    if (t.t === 'atom') return t.v;
    if (t.v === '(') {
      const v = or();
      const close = toks[i++];
      if (!close || close.t !== 'op' || close.v !== ')') throw new Error('unbalanced');
      return v;
    }
    throw new Error('unexpected token');
  };
  try {
    if (!toks.length) return null;
    const v = or();
    return i === toks.length ? v : null;
  } catch {
    return null;
  }
}

/**
 * Preprocess C++ source for a platform: keep only lines active for that platform.
 * Lines whose activity cannot be determined are replaced by a marker so callers can
 * report "unknown" rather than guess.
 */
export function preprocess(src: string, platform: Platform): string {
  const lines = src.split('\n');
  const out: string[] = [];
  // Each frame: [parentActive, thisBranchActive, anyBranchTaken]
  const stack: { parent: boolean | null; active: boolean | null; taken: boolean | null }[] = [];
  const isActive = () => (stack.length ? stack[stack.length - 1].active : true);
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^#\s*if\s+(.*)$/))) {
      const parent = isActive();
      const cond = evalCondition(m[1], platform);
      const active = parent === false ? false : parent === null || cond === null ? null : cond;
      stack.push({ parent, active, taken: cond });
      continue;
    }
    if ((m = t.match(/^#\s*ifdef\s+(\w+)/)) || (m = t.match(/^#\s*ifndef\s+(\w+)/))) {
      const parent = isActive();
      stack.push({ parent, active: parent === false ? false : null, taken: null });
      continue;
    }
    if ((m = t.match(/^#\s*elif\s+(.*)$/))) {
      const f = stack[stack.length - 1];
      if (!f) continue;
      const cond = evalCondition(m[1], platform);
      if (f.parent === false) f.active = false;
      else if (f.taken === true) f.active = false;
      else if (f.taken === null || cond === null || f.parent === null) f.active = null;
      else f.active = cond;
      if (cond === true && f.taken === false) f.taken = true;
      else if (cond === null) f.taken = null;
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      const f = stack[stack.length - 1];
      if (!f) continue;
      if (f.parent === false) f.active = false;
      else if (f.taken === null || f.parent === null) f.active = null;
      else f.active = !f.taken;
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      stack.pop();
      continue;
    }
    const a = isActive();
    if (a === true) out.push(line);
    else if (a === null) out.push('/*__UNKNOWN__*/' + line);
  }
  return out.join('\n');
}

function stripComments(src: string): string {
  return src.replace(/\/\*(?!__UNKNOWN__)[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Extract BASE_FEATURE and FeatureParam<bool> defaults for each platform. */
export function parseFeatureFlags(src: string, nameFilter: RegExp = /./): FlagValue[] {
  const byName = new Map<string, FlagValue>();
  const platforms: Platform[] = ['desktop', 'android', 'ios'];
  for (const p of platforms) {
    const code = stripComments(preprocess(src, p));
    // BASE_FEATURE(kName, "RuntimeName", base::FEATURE_ENABLED_BY_DEFAULT)
    for (const m of code.matchAll(/BASE_FEATURE\(\s*(k\w+)\s*,\s*(?:"([^"]+)"\s*,)?([^;]*?)\)\s*;/g)) {
      const [, sym, key, rest] = m;
      if (!nameFilter.test(sym) && !nameFilter.test(key ?? '')) continue;
      const unknown = rest.includes('__UNKNOWN__');
      const enabled = /FEATURE_ENABLED_BY_DEFAULT/.test(rest);
      const disabled = /FEATURE_DISABLED_BY_DEFAULT/.test(rest);
      const v: boolean | null = unknown || enabled === disabled ? null : enabled;
      const f = byName.get(sym) ?? { name: sym, kind: 'feature' as const, feature: null, key: key ?? sym.replace(/^k/, ''), defaults: { desktop: null, android: null, ios: null } };
      f.defaults[p] = v;
      byName.set(sym, f);
    }
    // const base::FeatureParam<bool> kParam{&kFeature, "param_name", true};
    for (const m of code.matchAll(/FeatureParam<bool>\s+(k\w+)\s*=?\s*(?:\{|\()\s*&\s*(k\w+)\s*,\s*"([^"]+)"\s*,\s*([^}\)]*?)\s*(?:\}|\))\s*;/g)) {
      const [, sym, feature, key, val] = m;
      if (!nameFilter.test(sym) && !nameFilter.test(key) && !nameFilter.test(feature)) continue;
      const v = val.includes('__UNKNOWN__') ? null : /^\s*true\s*$/.test(val) ? true : /^\s*false\s*$/.test(val) ? false : null;
      const f = byName.get(sym) ?? { name: sym, kind: 'param' as const, feature, key, defaults: { desktop: null, android: null, ios: null } };
      f.defaults[p] = v;
      byName.set(sym, f);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Cargo manifests
// ---------------------------------------------------------------------------

/** Parse [dependencies] of a Cargo.toml into crate -> version requirement. */
export function parseCargoDependencies(toml: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inDeps = false;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      inDeps = /^(dependencies|target\..*\.dependencies)$/.test(sec[1]);
      continue;
    }
    if (!inDeps || !line) continue;
    const simple = line.match(/^([\w-]+)\s*=\s*"([^"]+)"/);
    if (simple) {
      out[simple[1]] = simple[2];
      continue;
    }
    const table = line.match(/^([\w-]+)\s*=\s*\{(.*)\}/);
    if (table) {
      const ver = table[2].match(/version\s*=\s*"([^"]+)"/);
      const pkg = table[2].match(/package\s*=\s*"([^"]+)"/);
      out[pkg ? pkg[1] : table[1]] = ver ? ver[1] : table[2].includes('path') ? 'path' : table[2].includes('git') ? 'git' : '*';
    }
  }
  return out;
}

/** Parse a Cargo.lock into crate -> list of resolved versions. */
export function parseCargoLock(lock: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const block of lock.split(/\n\[\[package\]\]\n/)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) (out[name] ??= []).includes(version) || out[name].push(version);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brave issue/PR conventions
// ---------------------------------------------------------------------------

/** Release branch names look like "1.98.x". */
export function isReleaseBranch(ref: string | null | undefined): boolean {
  return Boolean(ref && /^\d+\.\d+\.x$/.test(ref));
}

/** QA labels: "QA Pass-Win64", "QA Pass - macOS", "QA Pass-Android ARM", "QA/Yes", ... */
export function parseQaLabels(labels: string[]): { passed: string[]; failed: string[]; required: boolean | null; blocked: boolean } {
  const passed: string[] = [];
  const failed: string[] = [];
  let required: boolean | null = null;
  let blocked = false;
  for (const l of labels) {
    const pass = l.match(/^QA\s*Pass\s*-?\s*(.+)$/i);
    if (pass) passed.push(pass[1].trim());
    const fail = l.match(/^QA\s*Fail(?:ed)?\s*-?\s*(.+)$/i);
    if (fail) failed.push(fail[1].trim());
    if (/^QA\/Yes$/i.test(l)) required = true;
    if (/^QA\/No$/i.test(l)) required = false;
    if (/^QA\/Blocked$/i.test(l)) blocked = true;
  }
  return { passed, failed, required, blocked };
}

/** Map a QA platform suffix to a tracker platform. */
export function qaPlatform(suffix: string): Platform | null {
  const s = suffix.toLowerCase();
  if (/android/.test(s)) return 'android';
  if (/ios|iphone|ipad/.test(s)) return 'ios';
  if (/win|mac|linux|desktop/.test(s)) return 'desktop';
  return null;
}

/** Platforms declared by OS/* labels. */
export function osLabels(labels: string[]): Platform[] {
  const out = new Set<Platform>();
  for (const l of labels) {
    const m = l.match(/^OS\/(.+)$/i);
    if (!m) continue;
    const p = m[1].toLowerCase();
    if (p.includes('android')) out.add('android');
    else if (p.includes('ios')) out.add('ios');
    else if (/desktop|windows|macos|linux|mac/.test(p)) out.add('desktop');
  }
  return [...out];
}

/** Milestone titles like "1.97.x - Release" -> { version: "1.97.x", channel: "release" }. */
export function parseMilestone(title: string | null | undefined): { line: string | null; channel: Channel | null } {
  if (!title) return { line: null, channel: null };
  const line = title.match(/(\d+\.\d+)\.x/)?.[1] ?? null;
  const ch = title.match(/-\s*(Release|Beta|Nightly)/i)?.[1]?.toLowerCase() as Channel | undefined;
  return { line, channel: ch ?? null };
}

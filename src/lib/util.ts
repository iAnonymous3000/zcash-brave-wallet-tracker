import { createHash } from 'node:crypto';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function shortHash(s: string, n = 16): string {
  return sha256(s).slice(0, n);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Compare dotted numeric versions ("1.97.56" vs "1.98.1"). Non-numeric parts compare as strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.+-]/);
  const pb = b.replace(/^v/, '').split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * SemVer 2.0 precedence (https://semver.org/#spec-item-11):
 * - build metadata ("+...") is ignored ("1.0.0+build.1" == "1.0.0");
 * - a prerelease ranks below its release ("0.24.0-rc.1" < "0.24.0");
 * - prerelease identifiers compare left to right: numeric identifiers numerically, alphanumeric ones in
 *   ASCII order, numeric below alphanumeric, and a shorter identifier list below a longer one with the
 *   same prefix (alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < release).
 * The core ("x.y.z") is compared with compareVersions, so missing parts count as 0 ("0.15" == "0.15.0").
 * Only the sign of the result is meaningful.
 */
export function compareSemver(a: string, b: string): number {
  const [ca, pa] = splitSemver(a);
  const [cb, pb] = splitSemver(b);
  const c = compareVersions(ca, cb);
  if (c !== 0) return c;
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return comparePrerelease(pa, pb);
}

/** Split "v1.2.3-rc.1+build-5" into core "1.2.3" and prerelease "rc.1" (null when absent); build metadata is dropped. */
function splitSemver(v: string): [string, string | null] {
  let s = v.trim().replace(/^v/, '');
  const plus = s.indexOf('+');
  if (plus !== -1) s = s.slice(0, plus);
  const dash = s.indexOf('-');
  return dash === -1 ? [s, null] : [s.slice(0, dash), s.slice(dash + 1)];
}

function comparePrerelease(a: string, b: string): number {
  const xa = a.split('.');
  const xb = b.split('.');
  const n = Math.min(xa.length, xb.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdentifier(xa[i], xb[i]);
    if (c !== 0) return c;
  }
  return xa.length === xb.length ? 0 : xa.length < xb.length ? -1 : 1;
}

function compareIdentifier(x: string, y: string): number {
  const nx = /^\d+$/.test(x);
  const ny = /^\d+$/.test(y);
  if (nx && ny) {
    // Arbitrary-length numeric identifiers: compare without precision loss.
    const bx = BigInt(x);
    const by = BigInt(y);
    return bx === by ? 0 : bx < by ? -1 : 1;
  }
  if (nx) return -1;
  if (ny) return 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

// The scanners below replace exactly what the commented regular expression would, left to right, in linear time.
// The expressions themselves rescan the rest of the text from every candidate start that fails (an unclosed "<!--",
// "<", "![", "[" or a line of spaces), which is quadratic: seconds for a 64 KB issue body or changelog line.

/** s.replace(/OPEN[\s\S]*?CLOSE/g, rep) for literal OPEN and CLOSE. Once no CLOSE follows an OPEN, none follows any later OPEN either. */
function replaceSpans(s: string, open: string, close: string, rep: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) break;
    const b = s.indexOf(close, a + open.length);
    if (b < 0) break;
    out += s.slice(i, a) + rep;
    i = b + close.length;
  }
  return out + s.slice(i);
}

/** s.replace(/<img[^>]*>/gi, rep). */
function replaceImgTags(s: string, rep: string): string {
  const img = /<img/gi;
  let out = '';
  let i = 0;
  for (;;) {
    img.lastIndex = i;
    const m = img.exec(s);
    if (!m) break;
    const b = s.indexOf('>', m.index + 4);
    if (b < 0) break;
    out += s.slice(i, m.index) + rep;
    i = b + 1;
  }
  return out + s.slice(i);
}

/** s.replace(/<[^>]+>/g, rep). */
function replaceTags(s: string, rep: string): string {
  let out = '';
  let i = 0;
  for (let from = 0; ; ) {
    const a = s.indexOf('<', from);
    if (a < 0) break;
    const b = s.indexOf('>', a + 1);
    if (b < 0) break;
    if (b === a + 1) {
      from = b; // "<>": nothing between
      continue;
    }
    out += s.slice(i, a) + rep;
    i = from = b + 1;
  }
  return out + s.slice(i);
}

/**
 * s.replace(/!\[[^\]]*\]\([^)]*\)/g, rep) when `image`, else s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1'). A start
 * that fails after its "]" fails the same way for every later start before that "]", so the scan resumes after it.
 */
function replaceLinks(s: string, image: boolean, rep: string): string {
  const open = image ? '![' : '[';
  // Without `image`, the link text and the destination must each have at least one character.
  const least = image ? 0 : 1;
  let out = '';
  let i = 0;
  for (let from = 0; ; ) {
    const a = s.indexOf(open, from);
    if (a < 0) break;
    const textStart = a + open.length;
    const q = s.indexOf(']', textStart);
    if (q < 0) break;
    if (q - textStart < least) {
      from = a + 1;
      continue;
    }
    if (s[q + 1] !== '(' || (least && s[q + 2] === ')')) {
      from = q + 1;
      continue;
    }
    const r = s.indexOf(')', q + 2);
    if (r < 0 || r - (q + 2) < least) break;
    out += s.slice(i, a) + (image ? rep : s.slice(textStart, q));
    i = from = r + 1;
  }
  return out + s.slice(i);
}

const WS = /\s/;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** s.replace(/^\s*>+\s?/gm, ''): block quote markers at line starts (\s crosses line ends, as in the expression). */
function stripQuoteMarkers(s: string): string {
  const n = s.length;
  /** The first line start at or after p (^ with the m flag: the text's start or just after a line terminator). */
  const lineStart = (p: number): number => {
    while (p <= n && p > 0 && !LINE_TERMINATOR.test(s[p - 1])) p++;
    return p;
  };
  let out = '';
  let i = 0;
  for (let p = 0; p <= n; ) {
    let r = p;
    while (r < n && WS.test(s[r])) r++;
    if (s[r] !== '>') {
      // Every line start up to r reaches the same non-">" character.
      p = lineStart(r + 1);
      continue;
    }
    let t = r;
    while (s[t] === '>') t++;
    if (t < n && WS.test(s[t])) t++;
    out += s.slice(i, p);
    i = t;
    p = lineStart(t);
  }
  return out + s.slice(i);
}

/** Convert Markdown/HTML-ish untrusted text to a compact plain-text excerpt. */
export function plainExcerpt(input: string | null | undefined, max = 420): string {
  if (!input) return '';
  let s = input;
  s = replaceSpans(s, '<!--', '-->', ' '); // /<!--[\s\S]*?-->/g
  s = replaceSpans(s, '```', '```', ' [code] '); // /```[\s\S]*?```/g
  s = replaceImgTags(s, ' [image] '); // /<img[^>]*>/gi
  s = replaceTags(s, ' '); // /<[^>]+>/g
  s = replaceLinks(s, true, ' [image] '); // /!\[[^\]]*\]\([^)]*\)/g
  s = replaceLinks(s, false, ''); // /\[([^\]]+)\]\(([^)]+)\)/g -> '$1'
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = stripQuoteMarkers(s); // /^\s*>+\s?/gm
  s = s.replace(/\*\*|__(?=\w)|(?<=\w)__|[*`]+/g, '');
  s = decodeEntities(s);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  try {
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

const REF_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/gi;
const REF_SHORT = /(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;

/** Extract GitHub issue/PR references (owner/repo#N) from text. `defaultRepo` resolves bare "#N". */
export function extractRefs(text: string | null | undefined, defaultRepo?: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(REF_URL)) out.add(`${m[1].toLowerCase()}/${m[2].toLowerCase()}#${m[3]}`);
  for (const m of text.matchAll(REF_SHORT)) out.add(`${m[1].toLowerCase()}/${m[2].toLowerCase()}#${m[3]}`);
  if (defaultRepo) {
    for (const m of text.matchAll(/(?<![\w/#&])#(\d{3,6})\b/g)) out.add(`${defaultRepo.toLowerCase()}#${m[1]}`);
  }
  return [...out];
}

export function itemId(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function parseItemId(id: string): { repo: string; number: number } {
  const i = id.lastIndexOf('#');
  return { repo: id.slice(0, i), number: Number(id.slice(i + 1)) };
}

export function itemUrl(id: string, kind: 'issue' | 'pr' = 'issue'): string {
  const { repo, number } = parseItemId(id);
  return `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
}

/** Only allow http(s) URLs to known-good shapes; returns null for anything else. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function byDateDesc<T>(get: (x: T) => string | null | undefined) {
  return (a: T, b: T) => (get(b) ?? '').localeCompare(get(a) ?? '');
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Never persist anything that looks like a token.
  return msg.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]').slice(0, 400);
}

/**
 * Check a version against a GitHub-advisory style range ("< 0.14.0", ">= 0.1, < 0.5.0", "<= 0.5.4", "= 1.2.3").
 * Returns null when the range cannot be parsed.
 */
export function satisfiesRange(version: string, range: string | null | undefined): boolean | null {
  if (!range) return null;
  const parts = range.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    const m = p.match(/^(<=|>=|<|>|=)?\s*v?([0-9][0-9A-Za-z.+-]*)$/);
    if (!m) return null;
    const c = compareSemver(version.replace(/^v/, ''), m[2]);
    const op = m[1] ?? '=';
    const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

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

/** Semver-ish comparison that ranks prereleases below the release ("0.24.0-rc.1" < "0.24.0"). */
export function compareSemver(a: string, b: string): number {
  const [ca, pa] = splitPre(a);
  const [cb, pb] = splitPre(b);
  const c = compareVersions(ca, cb);
  if (c !== 0) return c;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return compareVersions(pa.replace(/[a-z]+\.?/gi, ''), pb.replace(/[a-z]+\.?/gi, '')) || (pa < pb ? -1 : 1);
}

function splitPre(v: string): [string, string] {
  const s = v.replace(/^v/, '');
  const i = s.indexOf('-');
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** Convert Markdown/HTML-ish untrusted text to a compact plain-text excerpt. */
export function plainExcerpt(input: string | null | undefined, max = 420): string {
  if (!input) return '';
  let s = input;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/```[\s\S]*?```/g, ' [code] ');
  s = s.replace(/<img[^>]*>/gi, ' [image] ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/^\s*>+\s?/gm, '');
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

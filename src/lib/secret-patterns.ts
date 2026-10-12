// Shapes of credentials and private Brave references that must never be published. The build-output scan
// (scripts/scan-secrets.ts) fails on them, and collectors redact the same shapes from every stored free-text
// field (see redactNonPublicLinks), so public text that contains one cannot block publication.

export const SECRET_PATTERNS: [string, RegExp][] = [
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Bearer header', /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['Brave services key header', /x-brave-key\s*[:=]\s*["']?[A-Za-z0-9]{16,}/i],
  ['Private Brave reference', /github\.com\/brave\/(?:internal|reviews|security)\/(?:issues|pull)\/\d+/i],
];

/** Replace every SECRET_PATTERNS match; repeated because removing one match can join its neighbours into another. */
export function scrubSecretShapes(s: string): string {
  let out = s;
  for (let i = 0; i < 5; i++) {
    const before = out;
    for (const [, re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), '[redacted]');
    if (out === before) break;
  }
  return out;
}

/**
 * scrubSecretShapes() over every string in stored data, object keys included (upstream data can supply keys, e.g. a
 * variations study's parameter names). Run on each collector's result before it is written, so third-party text can
 * never stop the scan that gates publication, whichever field or source it arrives through. Values without a match
 * are returned as they are. Rebuilt objects keep every own property, including one named "__proto__" (as JSON.parse
 * creates it); two keys that scrub to the same text are kept apart with a numbered suffix.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubSecretShapes(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = scrubDeep(v);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(value)) {
      const key = scrubSecretShapes(k);
      const s = scrubDeep(v);
      if (s !== v || key !== k) changed = true;
      entries.push([key, s]);
    }
    if (!changed) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      let name = key;
      for (let n = 2; Object.hasOwn(out, name); n++) name = `${key} (${n})`;
      Object.defineProperty(out, name, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}

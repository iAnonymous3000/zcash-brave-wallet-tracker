// Minimal escaped-by-default HTML templating.
// Every interpolated value is HTML-escaped unless it is a SafeHtml produced by
// this module. Fetched (untrusted) text can therefore never inject markup.

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Interp = SafeHtml | string | number | boolean | null | undefined | Interp[];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(v: Interp): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Interp[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted constant markup (never pass fetched content here). */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

/** Only http(s) URLs survive; anything else becomes "#". */
export function href(url: string | null | undefined): string {
  if (!url) return '#';
  try {
    const u = new URL(url, 'https://example.invalid');
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      return url.startsWith('/') || url.startsWith('#') || url.startsWith('.') ? url : u.toString();
    }
  } catch {
    /* fall through */
  }
  return '#';
}

/** External link with safe rel attributes. */
export function ext(url: string | null | undefined, label: Interp, cls = ''): SafeHtml {
  return html`<a href="${href(url)}" class="${cls}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`;
}

/** Serialize JSON for embedding inside <script type="application/json">. */
export function jsonForScript(value: unknown): SafeHtml {
  return new SafeHtml(
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029'),
  );
}

// Round-3 regression tests for the ingest-services group (R3-ING-08, R3-DOCS).
// Collectors are driven through collect() with an injected fetch / GitHub stub; no network. Every "compiles" /
// "does not compile" claim below was checked with CPython 3.9 (compile() of the whole module), and every determinate
// value against the module-level value CPython computes with Chain provided and an `overrides` module whose
// SWAP_DISABLED_CHAINS contains Chain.ZCASH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { DocPage } from '../src/lib/types.ts';
import { parseGate3Switch, pythonStatements, services } from '../src/ingest/sources/services.ts';
import type { ServicesData } from '../src/ingest/sources/services.ts';
import { docs } from '../src/ingest/sources/docs.ts';

const NOW = '2026-10-08T20:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';
const SHA_A = 'a'.repeat(40);

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeCtx(route: Route, gh: Record<string, unknown> = {}): Ctx {
  const http = new Http({ fetch: async (url, init) => route(url, init), sleep: async () => {}, maxRetries: 0 });
  return { http, gh: gh as unknown as Ctx['gh'], now: NOW, trigger: 'test', log: () => {}, get: () => null };
}
const text = (body: string | Uint8Array<ArrayBuffer>, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ---------------------------------------------------------------------------
// R3-ING-08: gate3 SWAP_DISABLED_CHAINS
// ---------------------------------------------------------------------------

const IMPORT = 'from app.api.common.models import Chain\n';
const DEF = `${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ETH,)\n`;
/** The last determinate reading of the live run (data-live-int/sources/brave-services.json): disabled, line 18. */
const PREV_SERVICES: ServicesData = {
  gate3: { commitSha: SHA_A, file: 'app/api/swap/constants.py', zcashDisabled: true, line: 18, url: 'https://github.com/brave/gate3/blob/x', checkedAt: EARLIER },
  studies: [],
  studiesCommit: null,
};
const gate3Gh = { commitSha: async (repo: string) => (repo.includes('gate3') ? 'c'.repeat(40) : null), rest: async () => ({ data: [], res: new Response('[]') }) };

async function collectGate3(body: string | Uint8Array<ArrayBuffer>) {
  return services.collect(makeCtx(() => text(body), gate3Gh), PREV_SERVICES);
}
function assertGate3Unknown(r: Awaited<ReturnType<typeof collectGate3>>, label: string) {
  assert.equal(r.data.gate3?.zcashDisabled, null, `${label}: unknown`);
  assert.equal(r.data.gate3?.lastDetermined?.zcashDisabled, true, `${label}: the last determined value is kept`);
  assert.equal(r.partial, true, `${label}: partial`);
  assert.ok(r.limitations?.some((l) => /^gate3 at cccccccc: /.test(l)), `${label}: the limitation says why`);
}

test('R3-ING-08: a statement after ";" on a compound header line belongs to the block, never to the module', async () => {
  // The splitter keeps a compound header's one-line suite in the header's statement; simple statements still split.
  const split = (src: string) => pythonStatements(src).map((s) => [s.line, s.indent, s.code]);
  assert.deepEqual(split('def f(): pass; X = 1\nY = 2; Z = 3\nif A: raise E; B = 1\n'), [
    [1, 0, 'def f(): pass; X = 1'],
    [2, 0, 'Y = 2'],
    [2, 0, 'Z = 3'],
    [3, 0, 'if A: raise E; B = 1'],
  ]);
  assert.deepEqual(split('def f(): pass; \\\n  X = 1\n'), [[1, 0, 'def f(): pass;    X = 1']]);

  // In each module the assignment is a local of f, a class attribute or a statement of the block: CPython leaves the
  // module-level name unbound (or, after the star import, takes it from the imported module). Never a value.
  const suites = [
    'def f(): ...; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'def f(): pass; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'def f(): "doc"; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'def f() -> None: ...; SWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({MEMBER})',
    'def f(): pass; \\\n  SWAP_DISABLED_CHAINS = (MEMBER,)',
    'if False: raise ValueError; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'if Chain.ETH is None: raise ValueError("x"); SWAP_DISABLED_CHAINS = (MEMBER,)',
    'class K: pass; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'async def f(): pass; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'while False: pass; SWAP_DISABLED_CHAINS = (MEMBER,)',
    'for _ in (): pass; SWAP_DISABLED_CHAINS = (MEMBER,)',
  ];
  for (const suite of suites) {
    for (const member of ['Chain.ETH', 'Chain.ZCASH']) {
      for (const star of ['', 'from app.api.swap.legacy_constants import *  # noqa: F403\n']) {
        const src = `${IMPORT}${star}${suite.replace('MEMBER', member)}\n`;
        const r = parseGate3Switch(src);
        assert.equal(r.zcashDisabled, null, src);
        assert.ok(r.reason, `a reason is given: ${src}`);
      }
    }
  }
  // A canonical top-level definition followed by such a line: the line's suite never reads as part of the module.
  assert.equal(parseGate3Switch(`${DEF}def f(): pass; SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n`).zcashDisabled, null);
  assert.equal(parseGate3Switch(`${IMPORT}from overrides import *\nSWAP_DISABLED_CHAINS = (Chain.SOL,)\ndef f(): pass; SWAP_DISABLED_CHAINS = (Chain.ETH,)\n`).zcashDisabled, null);

  // The verifier's module through the collector: Python's value comes from the star import (Zcash disabled); the
  // last-good reading is kept and the run is partial.
  const verifier = [
    '"""Swap constants."""',
    'from app.api.common.models import Chain',
    'from app.api.swap.legacy_constants import *  # noqa: F403  (re-exports kept for old imports)',
    '',
    'DEFAULT_SLIPPAGE_PERCENTAGE = "0.5"',
    'def _reexports() -> None: ...; SWAP_DISABLED_CHAINS = {Chain.ETH}',
    '',
  ].join('\n');
  assert.deepEqual(parseGate3Switch(verifier), { zcashDisabled: null, line: 6, reason: 'SWAP_DISABLED_CHAINS is only assigned inside a block (conditional or nested definition)' });
  assertGate3Unknown(await collectGate3(verifier), 'verifier module');

  // Neighbours that stay determinate (CPython agrees on each value): simple statements split at ';', a single
  // trailing ';' after a one-line suite, `match` as a name, and a star import before the canonical top-level
  // definition (the definition runs later and wins).
  const reads: [string, boolean][] = [
    [`${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ETH,); X = 1\n`, false],
    [`${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ZCASH,);\n`, true],
    [`${IMPORT}def f(): pass;\nSWAP_DISABLED_CHAINS = (Chain.ETH,)\n`, false],
    [`${IMPORT}if Chain.ETH is None: raise ValueError;\nSWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n`, true],
    [`${DEF}match = 1; X = 2\n`, false],
    [`${IMPORT}from overrides import *\nSWAP_DISABLED_CHAINS = (Chain.SOL,)\n`, false],
    [`"doc"; ${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n`, true],
  ];
  for (const [src, v] of reads) assert.equal(parseGate3Switch(src).zcashDisabled, v, src);
});

test('R3-ING-08: after a star import the definition only wins when nothing after its store can run star-imported code', async () => {
  // A star import can bind any name (frozenset, Chain, __annotations__, ...) to an object whose __class_getitem__,
  // __setitem__, __hash__, __add__ or __getattr__ rebinds the switch. CPython 3.9 evaluates an annotated definition's
  // annotation and stores it into __annotations__ after storing the value, so in each module below such an object
  // runs after the store, and CPython's final value contains Chain.ZCASH (checked with star-exported objects that
  // rewrite the module's globals).
  const STAR = `${IMPORT}from app.api.swap.legacy_constants import *  # noqa: F403\n`;
  const SWAP = 'SWAP_DISABLED_CHAINS = (Chain.ETH,)\n';
  const cases = [
    `${STAR}SWAP_DISABLED_CHAINS: frozenset[Chain] = {Chain.ETH}\n`,
    `${STAR}SWAP_DISABLED_CHAINS: frozenset = {Chain.ETH}\n`,
    `${STAR}${SWAP}X: int = 1\n`,
    `${STAR}${SWAP}X: int\n`,
    `${STAR}${SWAP}X = {evil}\n`,
    `${STAR}${SWAP}X = {evil: 1}\n`,
    `${STAR}${SWAP}X = evil + 1\n`,
    `${STAR}${SWAP}X = not evil\n`,
    `${STAR}${SWAP}X = evil.attr\n`,
    `${STAR}SWAP_DISABLED_CHAINS = {Chain.ETH}\nX = SWAP_DISABLED_CHAINS.union(evil)\n`,
    `${STAR}${SWAP}def f(x: evil.T = 1): pass\n`,
  ];
  for (const src of cases) {
    const r = parseGate3Switch(src);
    assert.equal(r.zcashDisabled, null, src);
    assert.match(r.reason ?? '', /star import comes before the definition/, src);
  }
  assertGate3Unknown(await collectGate3(cases[0]), 'annotated definition after a star import');

  // Unchanged: an unannotated definition after the star import, followed by imports, strings and values made of
  // literals and plain names, is determinate; code before the definition cannot outlast its store.
  const quiet = `${STAR}X = evil + 1\nY: int = 2\n${SWAP}"""Notes."""\nimport os\n__all__ = ["SWAP_DISABLED_CHAINS"]\nZ = (evil, [1, "a"], {1: "b", 2: (3, -4)}, -1, None)\n`;
  assert.deepEqual(parseGate3Switch(quiet), { zcashDisabled: false, line: 5, reason: null });
});

test('R3-ING-08: modules CPython refuses to compile are unknown, never a determinate value', async () => {
  // Appended after a valid definition (Chain.ETH): the verifier's cases first, then close variants. CPython 3.9
  // rejects every one of these modules.
  const after = [
    // The verifier's cases.
    'X = 1 +',
    'X = (1,,)',
    'X = ur"abc"',
    'X = f"\\N{{"',
    '# a\0b',
    // Statement separators and line continuations.
    'X = 1;;',
    '; X = 1',
    'X = 1; if X: pass',
    'def f(): pass;;',
    'X = 1 + \\\n# c\n2',
    'X = 1 \\',
    // String literals.
    "X = 'a' b'b'",
    "X = b'\u00E9'",
    "X = '\\x4'",
    "X = b'\\x4'",
    "X = '\\U00110000'",
    "X = '\\N{NOT A CHARACTER NAME}'",
    "X = uf'x'",
    "X = abc 'x'",
    "X = f'}'",
    // Numbers.
    'X = 1_',
    'X = 1__0',
    'X = 012',
    'X = 0x',
    'X = 0b2',
    'X = 0o8',
    'X = 1_.5',
    'X = 1_e5',
    'X = 10L',
    'X = 1.real',
    // Expressions.
    'X = {1: 2, 3}',
    'X = (,)',
    'X = {,}',
    'X = - not 1',
    'X = frozenset(,)',
    'X = frozenset(**a, b)',
    'X = (*a)',
    'X = *a',
    'X = a.class',
    'X = (Chain.ETH +)',
    'if 1, 2: raise ValueError',
    'X: int, str = 1',
    // Parameter lists.
    'def f(x: int |): pass',
    'def f(a, a): pass',
    'def f(a, *a): pass',
    'def f(a=1, b): pass',
    'def f(a, *): pass',
    'def f(a, *, **k): pass',
    'def f(*,): pass',
    'def f(/, a): pass',
    'def f(a,,b): pass',
    'def f(,): pass',
    'def f(**k, a): pass',
    'def f(a, /, b, /): pass',
    'def f(*a, *b): pass',
    'def f(*, a, /): pass',
    'def f(*a=1): pass',
    'def f(__debug__): pass',
    // __future__ imports.
    'from __future__ import annotations',
    'from __future__ import braces',
    'from __future__ import *',
    'from __future__ import nonsense',
    'from .__future__ import annotations',
  ];
  for (const snippet of after) {
    const src = `${DEF}${snippet}\n`;
    const r = parseGate3Switch(src);
    assert.equal(r.zcashDisabled, null, JSON.stringify(src));
    assert.ok(r.reason, `a reason is given: ${JSON.stringify(src)}`);
  }
  // The definition itself not compiling, and a backslash continuation into the end of the file.
  for (const src of [`${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ZCASH,,)\n`, `${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ZCASH, ur'x')\n`, `${IMPORT}SWAP_DISABLED_CHAINS = (Chain.ZCASH,) \\\n`]) {
    assert.equal(parseGate3Switch(src).zcashDisabled, null, JSON.stringify(src));
  }
  // __future__ imports after anything but the docstring.
  for (const before of ['import os\n', "b'doc'\n", "f'doc'\n", '"""a"""\n"""b"""\n']) {
    const src = `${before}from __future__ import annotations\n${DEF}`;
    assert.equal(parseGate3Switch(src).zcashDisabled, null, JSON.stringify(src));
  }
  // Forms whose compiling depends on the Python version are unknown too: t-strings (3.14+), \N{...} names, a
  // continuation into a blank or comment-only line, very deep bracket nesting.
  for (const snippet of ["X = t'abc'", "X = '\\N{EM DASH}'", 'X = 1 \\\n\nY = 2', 'X = 1 \\\n# c', `X = ${'('.repeat(60)}1${')'.repeat(60)}`]) {
    assert.equal(parseGate3Switch(`${DEF}${snippet}\n`).zcashDisabled, null, snippet);
  }

  // Through the collector: unknown, partial, the last determined value kept.
  assertGate3Unknown(await collectGate3(`${DEF}X = 1 +\n`), 'trailing operator');
  assertGate3Unknown(await collectGate3(`${DEF}# a\0b\n`), 'NUL');
  // A file that is not valid UTF-8 (a stray Latin-1 byte in a comment) does not compile either; decoding it with
  // replacement characters would read it as a valid module.
  const latin1 = new Uint8Array([...new TextEncoder().encode(`${DEF}# caf`), 0xe9, 0x0a]);
  const r = await collectGate3(latin1);
  assertGate3Unknown(r, 'not UTF-8');
  assert.match(r.data.gate3?.reason ?? '', /not valid UTF-8/);

  // Valid neighbours keep their determinate value (CPython compiles each and leaves Zcash out of the switch).
  const valid = [
    'X = 1;',
    'def f(a, /, b=1, *c, d, **e): pass',
    'def f(*, a=1, b): pass',
    'def f(a,): pass',
    'def f(*a,): pass',
    'def f(**k,): pass',
    'def f(a, /,): pass',
    'def f(*a: int): pass',
    'X = (-1, +2.5e-3, 0x_1f, 0b1_0, 0o7, 1_000j, .5, 5., 1e+5, 1e1_0, 0x1e+5, 00, 0_0, 01e5, 01.5, 012j)',
    'X = ...',
    'X = 1 not in (2,)',
    'X = 1 is not None',
    'X = - - + ~ 1',
    'X = 2 ** -1',
    'X = 1 < 2 < 3',
    'X = not not 1',
    'X = frozenset((1, 2),)',
    "X = 'a'.upper",
    'X = {1: 2,}',
    "X = 'a' f'b'",
    "X = Rb'x' + BR'y'",
    "X = r'\\x4' + '\\X4' + rf'\\N'",
    "X = b'\\u12'",
    'X = 1, 2',
    'X = 1,',
    'X = {**{1: 2}, 3: 4}',
    'X = {*(1, 2), 3}',
    'X = (*(1, 2),)',
    'X = [*(1,), 2]',
    'X: tuple[Chain, ...] = (Chain.ETH,)',
    'X: "Chain" = Chain.ETH',
    'if Chain.ETH is None: raise ValueError;',
  ];
  for (const snippet of valid) assert.equal(parseGate3Switch(`${DEF}${snippet}\n`).zcashDisabled, false, snippet);
  for (const prologue of ['"""Swap constants."""\nfrom __future__ import annotations\n', "'doc'; from __future__ import annotations\n", 'from __future__ import (annotations,)\nfrom __future__ import division\n']) {
    assert.equal(parseGate3Switch(`${prologue}${DEF}`).zcashDisabled, false, prologue);
  }
});

// ---------------------------------------------------------------------------
// R3-DOCS: Help Center bodies and the listing/search merge
// ---------------------------------------------------------------------------

// The four Help Center pages captured by a live run of the merged code (scratchpad data-live-int/sources/docs.json).
const LIVE_SUPPORT_PAGES: DocPage[] = [
  { id: 'zendesk-26390040705165', source: 'support', title: 'Zcash and Address Types', url: 'https://support.brave.app/hc/en-us/articles/26390040705165-Zcash-and-Address-Types', updatedAt: '2025-04-02T17:12:57Z', contentHash: '35330fe13fa96296', zcashStatements: ['Zcash is a secure digital currency that helps protect your privacy.', 'With Zcash, there are two types of addresses:', 'Transparent addresses: Transactions with transparent addresses, or t-addresses, can be tracked on the Zcash blockchain the same way Bitcoin can.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
  { id: 'zendesk-12747992885389', source: 'support', title: 'What is Brave Wallet?', url: 'https://support.brave.app/hc/en-us/articles/12747992885389-What-is-Brave-Wallet', updatedAt: '2025-11-13T22:16:24Z', contentHash: 'b50a98de04250093', zcashStatements: ['Support transparent and private shielded Zcash transactions.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
  { id: 'zendesk-4415497656461', source: 'support', title: 'Brave Wallet FAQ', url: 'https://support.brave.app/hc/en-us/articles/4415497656461-Brave-Wallet-FAQ', updatedAt: '2024-08-06T14:17:49Z', contentHash: 'e5f7d6f1ad6ac6de', zcashStatements: ['Brave Wallet supports Ethereum, EVM-compatible chains and L2s, Solana, Bitcoin, Zcash, and Filecoin.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
  { id: 'zendesk-12744130666509', source: 'support', title: 'How does Brave Wallet differ from other wallets?', url: 'https://support.brave.app/hc/en-us/articles/12744130666509-How-does-Brave-Wallet-differ-from-other-wallets', updatedAt: '2025-11-13T22:29:09Z', contentHash: '5ddad1adb949605b', zcashStatements: ['Brave Wallet users can buy, receive, and send crypto assets across multiple chains, including Ethereum, EVM compatible chains, and Solana, Zcash, and Bitcoin.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
];
const PREV_DOCS = { pages: LIVE_SUPPORT_PAGES, history: [] };
const liveId = (p: DocPage) => Number(p.id.replace('zendesk-', ''));
/** Article records for the live pages: same ids, titles and URLs, plus the given fields. */
const liveRecords = (extra: (p: DocPage) => Record<string, unknown>) => LIVE_SUPPORT_PAGES.map((p) => ({ id: liveId(p), title: p.title, html_url: p.url, edited_at: p.updatedAt, ...extra(p) }));

function docsRoute(opts: { list: unknown[]; search?: unknown[]; article?: (id: string) => Response }): Route {
  return (url) => {
    const one = /\/articles\/(\d+)\.json/.exec(url);
    if (one) return opts.article ? opts.article(one[1]) : text('busy', 503);
    if (url.includes('/categories/')) return json({ articles: opts.list });
    if (url.includes('/search.json')) return json({ results: opts.search ?? [] });
    return text('<main><p>Zcash is supported.</p></main>');
  };
}
const supportHistory = (r: { data: { history: { id: string; state?: string }[] } }) => r.data.history.filter((h) => h.id.startsWith('zendesk-'));

function assertLiveKept(r: { data: { pages: DocPage[]; history: { id: string }[] }; partial?: boolean }, label: string) {
  assert.equal(r.partial, true, `${label}: not a clean refresh`);
  assert.deepEqual(supportHistory(r), [], `${label}: no Help Center statement archived (removed, reworded or superseded)`);
  for (const old of LIVE_SUPPORT_PAGES) assert.deepEqual(r.data.pages.find((p) => p.id === old.id), old, `${label}: ${old.id} kept unchanged`);
}

/** Bodies with no visible text: invisible named and numeric references, the characters themselves, fillers. */
const INVISIBLE_BODIES = [
  '<p>&#8203;</p>',
  '<p>&#x200b;</p>',
  '<p>&#8203</p>',
  '<p>\u200B</p>',
  '<p>&ensp;</p>',
  '<p>&emsp;&emsp13;&emsp14;</p>',
  '<p>&thinsp;&hairsp;&numsp;&puncsp;</p>',
  '<p>&zwnj;&zwj;</p>',
  '<p>&ZeroWidthSpace;</p>',
  '<p>&NegativeThickSpace;&NegativeMediumSpace;&NegativeThinSpace;&NegativeVeryThinSpace;</p>',
  '<p>&shy;</p>',
  '<p>&shy</p>',
  '<p>&nbsp</p>',
  '<p>\u00AD</p>',
  '<p>&#xFEFF;</p>',
  '<p>\uFEFF</p>',
  '<p>&lrm;&rlm;&NoBreak;&InvisibleTimes;&it;</p>',
  '<p>\u2060\u2061\u180E\u3164\u2800</p>',
  '<p>\u3000\u202F\u205F</p>',
  '<p>&#0;</p>',
];

test('R3-DOCS: bodies made only of invisible characters are unreadable: last-good pages kept, nothing archived, partial', async () => {
  for (const body of INVISIBLE_BODIES) {
    // In the listing (same ids, titles unchanged), with the direct look-up busy.
    const listed = await docs.collect(makeCtx(docsRoute({ list: liveRecords(() => ({ body })) })), PREV_DOCS);
    assertLiveKept(listed, `listing body ${JSON.stringify(body)}`);
    assert.ok(listed.limitations?.some((l) => /4 Help Center article\(s\) were listed without a body \(missing or empty/.test(l)), JSON.stringify(body));
    // In the direct look-up, after a listing without bodies (or with the same invisible body): a partial run never
    // replaces the last-good pages.
    for (const listing of [{}, { body }]) {
      const looked = await docs.collect(makeCtx(docsRoute({ list: liveRecords(() => listing), article: (id) => json({ article: { id: Number(id), title: 'Zcash and Address Types', html_url: 'u', body } }) })), PREV_DOCS);
      assertLiveKept(looked, `look-up body ${JSON.stringify(body)}, listing ${JSON.stringify(listing)}`);
    }
  }
  // With nothing captured before, a Zcash-titled article whose body is invisible is not captured as an empty page.
  const elsewhere = { id: 999, title: 'Zcash fees', html_url: 'https://support.brave.app/hc/999', body: '<p>Zcash fees follow ZIP-317.</p>' };
  const fresh = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, { id: 6, title: 'Zcash shielding', html_url: 'u', body: '<p>&ZeroWidthSpace;&ensp;</p>' }] })), null);
  assert.equal(fresh.partial, true);
  assert.equal(fresh.data.pages.some((p) => p.id === 'zendesk-6'), false);

  // Visible text around invisible characters is readable: a real rewording is still recorded as one.
  const reworded = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, ...liveRecords(() => ({ title: 'Wallet basics', body: '<p>&ensp;Brave Wallet supports many chains.&ZeroWidthSpace;</p>' }))] })), PREV_DOCS);
  assert.equal(reworded.partial, false);
  assert.deepEqual(supportHistory(reworded).map((h) => h.state), ['no-longer-mentions-zcash', 'no-longer-mentions-zcash', 'no-longer-mentions-zcash', 'no-longer-mentions-zcash']);
});

test('R3-DOCS: "published" from any source survives the listing/search merge; a draft copy never stands in for it', async () => {
  // Listing published without a body, search returns the same ids as drafts with a body (or the other way round);
  // the direct look-up answering 404, 410 or draft contradicts "published": the last copy is kept, partial.
  const lookups: [string, (id: string) => Response][] = [
    ['404', () => text('nf', 404)],
    ['410', () => text('gone', 410)],
    ['draft', (id) => json({ article: { id: Number(id), draft: true, title: 'x', html_url: 'u', body: '<p>Draft text.</p>' } })],
  ];
  const draftReadable = () => ({ draft: true, body: '<p>Old text about wallets.</p>' });
  for (const [label, article] of lookups) {
    for (const bodyless of [{}, { body: '' }, { body: '<p>&#8203;</p>' }]) {
      const a = await docs.collect(makeCtx(docsRoute({ list: liveRecords(() => bodyless), search: liveRecords(draftReadable), article })), PREV_DOCS);
      assertLiveKept(a, `listing published ${JSON.stringify(bodyless)} + search draft, look-up ${label}`);
      assert.ok(a.limitations?.some((l) => /listed as published, but the article look-up/.test(l)), label);
      const b = await docs.collect(makeCtx(docsRoute({ list: liveRecords(draftReadable), search: liveRecords(() => bodyless), article })), PREV_DOCS);
      assertLiveKept(b, `listing draft + search published ${JSON.stringify(bodyless)}, look-up ${label}`);
      assert.ok(b.limitations?.some((l) => /listed as published, but the article look-up/.test(l)), label);
    }
  }

  // The published copy's content is what is read: published without Zcash wording, draft (search) still with it,
  // is a real rewording of the published article.
  const reworded = await docs.collect(
    makeCtx(docsRoute({ list: liveRecords(() => ({ title: 'Wallet basics', body: '<p>Brave Wallet supports many chains.</p>' })), search: liveRecords((p) => ({ draft: true, body: `<p>${p.zcashStatements[0]}</p>` })) })),
    PREV_DOCS,
  );
  assert.equal(reworded.partial, false);
  assert.deepEqual(supportHistory(reworded).map((h) => [h.id, h.state]), LIVE_SUPPORT_PAGES.map((p) => [p.id, 'no-longer-mentions-zcash']));
  // ...and a published copy with Zcash wording is captured from that copy, whatever the draft copy says.
  const published = await docs.collect(
    makeCtx(docsRoute({ list: liveRecords(() => ({ draft: true, body: '<p>Draft: Zcash support is being rewritten.</p>' })), search: liveRecords(() => ({ body: '<p>Zcash is supported in Brave Wallet today.</p>' })) })),
    null,
  );
  assert.equal(published.partial, false);
  for (const p of LIVE_SUPPORT_PAGES) assert.deepEqual(published.data.pages.find((x) => x.id === p.id)?.zcashStatements, ['Zcash is supported in Brave Wallet today.'], p.id);

  // Unchanged: shown only as a draft everywhere and answering 404 is an unpublished (removed) article.
  const elsewhere = { id: 999, title: 'Zcash fees', html_url: 'https://support.brave.app/hc/999', body: '<p>Zcash fees follow ZIP-317.</p>' };
  const drafted = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, ...liveRecords(draftReadable)], search: liveRecords(draftReadable), article: () => text('nf', 404) })), PREV_DOCS);
  assert.equal(drafted.partial, false);
  assert.deepEqual(supportHistory(drafted).map((h) => h.state), ['removed', 'removed', 'removed', 'removed']);
});

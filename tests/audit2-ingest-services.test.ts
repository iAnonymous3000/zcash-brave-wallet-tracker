// Round-2 regression tests for the ingest-services group (R-ING-08, R-DOCS, R-STUDY-SCOPE, R-STUDY-REASON).
// Collectors are driven through collect() with an injected fetch / GitHub stub; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { ChannelVersion, DocPage, SourceEnvelope } from '../src/lib/types.ts';
import { isRelevantStudy, parseGate3Switch, services } from '../src/ingest/sources/services.ts';
import type { ServicesData, StudyInfo } from '../src/ingest/sources/services.ts';
import { docs } from '../src/ingest/sources/docs.ts';

const NOW = '2026-10-08T20:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeCtx(route: Route, gh: Record<string, unknown> = {}, envs: Record<string, SourceEnvelope<unknown>> = {}): Ctx & { calls: string[] } {
  const calls: string[] = [];
  const http = new Http({
    fetch: async (url, init) => {
      calls.push(url);
      return route(url, init);
    },
    sleep: async () => {},
    maxRetries: 0,
  });
  return { http, gh: gh as unknown as Ctx['gh'], now: NOW, trigger: 'test', log: () => {}, get: <T>(id: string) => (envs[id] ?? null) as SourceEnvelope<T> | null, calls };
}

const env = <T>(sourceId: string, data: T, retrievedAt = EARLIER): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt, data });
const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function servicesGh(opts: { gate3?: string | null; variations?: string | null; listing?: unknown[] }) {
  return {
    commitSha: async (repo: string) => (repo.includes('gate3') ? (opts.gate3 === undefined ? SHA_A : opts.gate3) : opts.variations === undefined ? SHA_B : opts.variations),
    rest: async () => ({ data: opts.listing ?? [], res: new Response('[]') }),
  };
}
const GATE3_ON = 'from app.api.common.models import Chain\n\nSWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({Chain.ZCASH})\n';

// ---------------------------------------------------------------------------
// R-ING-08: every other binding of the switch is unknown
// ---------------------------------------------------------------------------

test('R-ING-08: rebinding forms (target lists, starred, attribute, keyword, type alias, ...) are unknown, never a determinate false', async () => {
  const DEF = 'SWAP_DISABLED_CHAINS = (Chain.ETH,)\n';
  const rebinding = [
    // The literal forms from the finding.
    '[A, SWAP_DISABLED_CHAINS] = [1, (Chain.ZCASH,)]',
    'A, *SWAP_DISABLED_CHAINS = load()',
    'sys.modules[__name__].SWAP_DISABLED_CHAINS = (Chain.ZCASH,)',
    'globals().update(SWAP_DISABLED_CHAINS=(Chain.ZCASH,))',
    'type SWAP_DISABLED_CHAINS = tuple[Chain]',
    // Variants of the same structure.
    '(A, (B, SWAP_DISABLED_CHAINS)) = (1, (2, (Chain.ZCASH,)))',
    '[*SWAP_DISABLED_CHAINS] = [Chain.ZCASH]',
    'constants.SWAP_DISABLED_CHAINS = (Chain.ZCASH,)',
    'X = Y = SWAP_DISABLED_CHAINS = (Chain.ZCASH,)',
    'SWAP_DISABLED_CHAINS: tuple = (Chain.ZCASH,)',
    'SWAP_DISABLED_CHAINS //= 1',
    'print(SWAP_DISABLED_CHAINS := (Chain.ZCASH,))',
    'ns.update(SWAP_DISABLED_CHAINS=(Chain.ZCASH,))',
    'with load() as SWAP_DISABLED_CHAINS:\n    pass',
    'try:\n    pass\nexcept Exception as SWAP_DISABLED_CHAINS:\n    pass',
    'for SWAP_DISABLED_CHAINS in [(Chain.ZCASH,)]: pass',
    'for a, (b, SWAP_DISABLED_CHAINS) in pairs: pass',
    'del SWAP_DISABLED_CHAINS',
    'import overrides as SWAP_DISABLED_CHAINS',
    'def SWAP_DISABLED_CHAINS(): pass',
    'class SWAP_DISABLED_CHAINS: pass',
    'def reset():\n    global SWAP_DISABLED_CHAINS',
    'match load():\n    case SWAP_DISABLED_CHAINS:\n        pass',
    'SWAP_DISABLED_CHAINS.extend([Chain.ZCASH])',
    'g = globals()\ng["SWAP_DISABLED_CHAINS"] = (Chain.ZCASH,)',
    'exec(OVERRIDES)',
    'setattr(module, name, (Chain.ZCASH,))',
    'sys.modules[__name__].__dict__.update(cfg)',
    // f-string replacement fields are code too.
    'log.info(f"{(SWAP_DISABLED_CHAINS := (Chain.ZCASH,))}")',
    "NOTE = f'disabled: {SWAP_DISABLED_CHAINS.append(Chain.ZCASH)}'",
    'NOTE = f"{globals().update(SWAP_DISABLED_CHAINS=(Chain.ZCASH,))}"',
  ];
  for (const form of rebinding) {
    const r = parseGate3Switch(`${DEF}${form}\n`);
    assert.equal(r.zcashDisabled, null, form);
    assert.ok(r.reason, `a reason is given: ${form}`);
  }
  // The same forms before the definition cannot be told apart from a run-time rebinding either (a function defined
  // earlier can be called later); only the definition alone is determinate.
  assert.equal(parseGate3Switch(`[A, SWAP_DISABLED_CHAINS] = [1, (Chain.ZCASH,)]\n`).zcashDisabled, null);

  // Inert reads. Under the strict constants-module allowlist only the real repository layout (GATE3_ON) stays
  // determinate; the others import no Chain before the switch and use statement shapes outside the allowlist, so
  // they are now unknown.
  const reads: [string, boolean | null][] = [
    [GATE3_ON, true],
    ['SWAP_DISABLED_CHAINS: frozenset[Chain]\nSWAP_DISABLED_CHAINS = frozenset({Chain.ETH})\n', null], // strict allowlist: unknown
    ['SWAP_DISABLED_CHAINS = (Chain.ETH,)\nDOC = "SWAP_DISABLED_CHAINS = (Chain.ZCASH,) and globals() are only words here"\n', null], // strict allowlist: unknown
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nALIAS = SWAP_DISABLED_CHAINS\nCOPY = frozenset(SWAP_DISABLED_CHAINS)\n', null], // strict allowlist: unknown
    ['SWAP_DISABLED_CHAINS = (Chain.ETH,)\nSWAP_DISABLED_CHAINS: tuple[Chain, ...]\nNOTE = f"{{SWAP_DISABLED_CHAINS := x}} is only text"\n', null], // strict allowlist: unknown
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nOTHER = frozenset(SWAP_DISABLED_CHAINS) | {Chain.ETH}\n', null], // strict allowlist: unknown
  ];
  for (const [src, v] of reads) assert.equal(parseGate3Switch(src).zcashDisabled, v, src);
  // Repair round: these modules were first read as determinate, but each one has a statement that runs code the file
  // cannot vouch for (a comprehension, a for loop, a call to len(), a def with a body, an f-string field). The verifier's
  // counter-examples (a function that appends to its argument, setattr reached through an alias or functools.partial,
  // operator.setitem, ...) have exactly that shape, so the module is read with an allowlist and such modules are
  // unknown rather than a guess.
  const runsCode = [
    'SWAP_DISABLED_CHAINS = (Chain.ETH,)\nOK = [c for c in CHAINS if c not in SWAP_DISABLED_CHAINS]\n',
    'SWAP_DISABLED_CHAINS = (Chain.ETH,)\nd = {c: c in SWAP_DISABLED_CHAINS for c in CHAINS}\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nfor c in SWAP_DISABLED_CHAINS: register(c)\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nsmall = len(SWAP_DISABLED_CHAINS) <= 3\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\ndef f(chain, disabled=SWAP_DISABLED_CHAINS):\n    return chain in disabled\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nlog.info(f"{SWAP_DISABLED_CHAINS} loaded; {SWAP_DISABLED_CHAINS=}; {{SWAP_DISABLED_CHAINS := x}}")\n',
  ];
  for (const src of runsCode) assert.equal(parseGate3Switch(src).zcashDisabled, null, src);

  // Through the collector: unknown, partial, last determined value kept.
  const prev: ServicesData = {
    gate3: { commitSha: SHA_A, file: 'app/api/swap/constants.py', zcashDisabled: true, line: 3, url: 'https://github.com/brave/gate3/blob/x', checkedAt: EARLIER },
    studies: [],
    studiesCommit: null,
  };
  const src = `${DEF}[A, SWAP_DISABLED_CHAINS] = [1, (Chain.ZCASH,)]\n`;
  const r = await services.collect(makeCtx(() => text(src), servicesGh({ gate3: 'c'.repeat(40), variations: null })), prev);
  assert.equal(r.data.gate3?.zcashDisabled, null);
  assert.equal(r.data.gate3?.lastDetermined?.zcashDisabled, true);
  assert.equal(r.partial, true);
});

// Repair round. Every case below was run with CPython (the module executed with Chain provided, an `overrides` module
// defining SWAP_DISABLED_CHAINS = (Chain.ZCASH,)): Python's final value contains Chain.ZCASH in each, so a determinate
// false would be wrong. The parser now reads the module with an allowlist (imports, docstrings, NAME = literal) and
// leaves every other module unknown.
const REAL_GATE3_CONSTANTS = `from app.api.common.models import Chain

# Default slippage percentage for providers that do not support automatic
# slippage computation
DEFAULT_SLIPPAGE_PERCENTAGE = "0.5"

# Chains temporarily excluded from swap/bridge routing entirely.
#
# Zcash is disabled because Brave Wallet currently sends a shielded-only
# unified address (u1...) as the swap recipient. Bridge providers honour
# whatever recipient they are given, so the payout lands in a shielded pool the
# wallet cannot scan: the funds arrive, but are invisible to the user.
#
# Re-enable by removing Chain.ZCASH here, once brave-core ships (and uplifts)
# the fix that sends a transparent recipient. Pair that with a
# recipient/refund_to validation guard that rejects shielded addresses, so
# shielded support doesn't come back accidentally before Ironwood ships.
SWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({Chain.ZCASH})
`;

test('R-ING-08 (repair): namespace access by any route, hidden statements, star imports, NFKC names, f-string fields and mutating calls are unknown, never false', async () => {
  const DEF = 'SWAP_DISABLED_CHAINS = (Chain.ETH,)\n';
  const LDEF = 'SWAP_DISABLED_CHAINS = [Chain.ETH]\n';
  const cases: [string, string][] = [
    // (1) Dynamic namespace forms: dotted calls, the globals dict reached through functions and frames, aliases.
    ['builtins.exec', `${DEF}import builtins\nbuiltins.exec("SWAP_DISABLED_CHAINS = (Chain.ZCASH,)")\n`],
    ['builtins.setattr', `${DEF}import builtins, importlib\nbuiltins.setattr(importlib.import_module(__name__), "SWAP_DISABLED_CHAINS", (Chain.ZCASH,))\n`],
    ['f.__globals__', `${DEF}def f(): pass\nf.__globals__["SWAP_DISABLED_CHAINS"] = (Chain.ZCASH,)\n`],
    ['frame f_globals', `${DEF}import inspect\ninspect.currentframe().f_globals["SWAP_DISABLED_CHAINS"] = (Chain.ZCASH,)\n`],
    ['sys._getframe', `${DEF}import sys\nsys._getframe().f_globals.update({"SWAP_DISABLED_CHAINS": (Chain.ZCASH,)})\n`],
    ['lambda __globals__', `${DEF}(lambda: 0).__globals__.update({"SWAP_DISABLED_CHAINS": (Chain.ZCASH,)})\n`],
    ['partial(setattr)', `${DEF}import functools, importlib\nfunctools.partial(setattr, importlib.import_module(__name__))("SWAP_DISABLED_CHAINS", (Chain.ZCASH,))\n`],
    ['setattr alias', `${DEF}import importlib\nfrom builtins import setattr as s\ns(importlib.import_module(__name__), "SWAP_DISABLED_CHAINS", (Chain.ZCASH,))\n`],
    ['getattr exec', `${DEF}import builtins\ngetattr(builtins, "exec")("SWAP_DISABLED_CHAINS = (Chain.ZCASH,)")\n`],
    ['module from a call', `${DEF}import importlib\nm = importlib.import_module(__name__)\n`],
    ['imported __builtins__', `from fakebuiltins import __builtins__\nSWAP_DISABLED_CHAINS = frozenset({Chain.ETH})\n`],
    // (2) A statement hidden by the tokenizer: a quote right after a keyword starts a string.
    ['else"""', `${DEF}a = b = 1\nX = a if b else"""\n"""; SWAP_DISABLED_CHAINS = (Chain.ZCASH,); Y = """\n"""\n`],
    ['or"""', `${DEF}a = 1\nX = a or"""\n"""; SWAP_DISABLED_CHAINS = (Chain.ZCASH,); Y = """\n"""\n`],
    // (3) A star import after a one-line compound header, or after ';'.
    ['if: star import', `${DEF}if True: from overrides import *\n`],
    ['; star import', `${DEF}pass; from overrides import *\n`],
    // (4) Identifiers Python normalises with NFKC.
    ['fullwidth S', `${DEF}ＳWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n`],
    ['mathematical bold S', `${DEF}\u{1D412}WAP_DISABLED_CHAINS = (Chain.ZCASH,)\n`],
    ['fullwidth member', 'SWAP_DISABLED_CHAINS = (Chain.ETH, Chain.ＺCASH)\n'],
    // (5) A string containing a brace inside an f-string replacement field.
    ['f-string brace in string', `${DEF}X = f"{'}' + str(SWAP_DISABLED_CHAINS := (Chain.ZCASH,))}"\n`],
    ['t-string field', `${DEF}X = t"{(SWAP_DISABLED_CHAINS := (Chain.ZCASH,))}"\n`],
    // (6) In-place mutation of a mutable definition, directly, through a function or through an alias.
    ['list.append', `${LDEF}list.append(SWAP_DISABLED_CHAINS, Chain.ZCASH)\n`],
    ['list.extend', `${LDEF}list.extend(SWAP_DISABLED_CHAINS, [Chain.ZCASH])\n`],
    ['operator.setitem', `${LDEF}import operator\noperator.setitem(SWAP_DISABLED_CHAINS, 0, Chain.ZCASH)\n`],
    ['operator.iadd', `${LDEF}import operator\noperator.iadd(SWAP_DISABLED_CHAINS, [Chain.ZCASH])\n`],
    ['set.add', 'SWAP_DISABLED_CHAINS = {Chain.ETH}\nset.add(SWAP_DISABLED_CHAINS, Chain.ZCASH)\n'],
    ['function appends to its argument', `${LDEF}def add(l):\n    l.append(Chain.ZCASH)\nadd(SWAP_DISABLED_CHAINS)\n`],
    ['alias append', `${LDEF}_l = SWAP_DISABLED_CHAINS\n_l.append(Chain.ZCASH)\n`],
    // Source-level forms that change what Python reads: a UTF-7 newline in a comment, a form feed resetting the
    // indentation, lone carriage returns as line ends.
    ['utf-7 comment', '# coding: utf-7\nSWAP_DISABLED_CHAINS = (Chain.ETH,) #+AAo-SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n'],
    ['form feed', `${DEF}    \fSWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n`],
    ['CR line ends', 'SWAP_DISABLED_CHAINS = (Chain.ETH,)\rSWAP_DISABLED_CHAINS = (Chain.ZCASH,)\r'],
  ];
  for (const [name, src] of cases) {
    const r = parseGate3Switch(src);
    assert.equal(r.zcashDisabled, null, `${name}: Python's value contains Chain.ZCASH, so the answer is unknown, not false`);
    assert.ok(r.reason, `${name}: a reason is given`);
  }

  // The real file (app/api/swap/constants.py at the time of writing) stays determinate. The realistic richer constants
  // module (imports also parenthesised, aliased, __future__; docstrings, literal constants, an annotation-only line,
  // an alias of the switch and a constructor copy of it) was determinate under the old reader; the strict allowlist
  // stops at its `from __future__` line and answers unknown.
  const real = parseGate3Switch(REAL_GATE3_CONSTANTS);
  assert.deepEqual(real, { zcashDisabled: true, line: 18, reason: null });
  const rich = (members: string) =>
    `"""Swap constants."""\nfrom __future__ import annotations\n\nimport enum\nfrom app.api.common.models import (\n    Chain,\n    Provider as P,\n)\n\nDEFAULT_SLIPPAGE_PERCENTAGE = "0.5"\nMAX_RETRIES: int = 3\nTIMEOUT = -1.5\nFEES = {"a": 1, "b": [1, 2], "c": (P, None)}\nSWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({${members}})\nALIAS = SWAP_DISABLED_CHAINS\nCOPY = tuple(SWAP_DISABLED_CHAINS)\nSWAP_DISABLED_CHAINS: frozenset[Chain]\nNOTE = f"literal only {{braces}}"; pass\n`;
  // The reader names the first line it does not accept; line 2 is `from __future__ import annotations`.
  const notAcceptedLine2 = { zcashDisabled: null, line: 2, reason: 'line 2 is not one of the statement shapes this reader accepts; only a plain constants module is read, so the value of SWAP_DISABLED_CHAINS is not determined' };
  assert.deepEqual(parseGate3Switch(rich('Chain.ETH, Chain.SOL')), notAcceptedLine2); // strict allowlist: unknown (was false, line 14)
  assert.deepEqual(parseGate3Switch(rich('Chain.ETH, Chain.ZCASH')), notAcceptedLine2); // strict allowlist: unknown (was true, line 14)
  // ...and the same module with one more statement that runs code is unknown, whichever value the literal has.
  for (const extra of ['from app.registry import register\nregister(SWAP_DISABLED_CHAINS)', 'if DEBUG: pass', 'Chain = OtherChain', 'frozenset = set', 'SWAP_DISABLED_CHAINS = SWAP_DISABLED_CHAINS - {Chain.ETH}']) {
    for (const members of ['Chain.ETH', 'Chain.ZCASH']) assert.equal(parseGate3Switch(`${rich(members)}${extra}\n`).zcashDisabled, null, extra);
  }

  // The few statement forms beyond NAME = literal that the old reader accepted (each cannot run code of this module):
  // `__all__`, an `if ...: raise BuiltinError(...)` guard, a one-line `def ...: ...` without a body, operators, and
  // read-only methods called on the switch itself. Python agrees on both values; the strict allowlist accepts none of
  // these forms and stops at the `__all__` line, so both are now unknown.
  const guarded = (members: string) =>
    `"""Swap constants."""\n__all__ = ["SWAP_DISABLED_CHAINS", "is_disabled"]\nfrom app.api.common.models import Chain\nSWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({${members}})\nif Chain.ETH in SWAP_DISABLED_CHAINS: raise ValueError("ETH must stay routable")\ndef is_disabled(chain: Chain, *, disabled: frozenset[Chain] = SWAP_DISABLED_CHAINS) -> bool: ...\nROUTABLE = SWAP_DISABLED_CHAINS.symmetric_difference({Chain.ETH, Chain.SOL})\nOTHER = frozenset(SWAP_DISABLED_CHAINS) | {Chain.ETH}\nNOT_ETH = Chain.ETH not in SWAP_DISABLED_CHAINS and Chain.SOL is not None\n`;
  // The reader names the first line it does not accept; line 2 is `__all__ = [...]`.
  assert.deepEqual(parseGate3Switch(guarded('Chain.ZCASH')), notAcceptedLine2); // strict allowlist: unknown (was true, line 4)
  assert.deepEqual(parseGate3Switch(guarded('Chain.SOL')), notAcceptedLine2); // strict allowlist: unknown (was false, line 4)
  // ...but not when they could run something else. Python's value contains Chain.ZCASH in each of these:
  const narrowed: [string, string][] = [
    ['star import rebinding frozenset', 'from rebind import *\nSWAP_DISABLED_CHAINS = frozenset({Chain.ETH})\n'],
    ['mutating default', `${LDEF}def f(x=SWAP_DISABLED_CHAINS.append(Chain.ZCASH)): pass\n`],
    ['mutating method in a value', `${LDEF}X = SWAP_DISABLED_CHAINS.append(Chain.ZCASH)\n`],
    ['mutating method statement', `${LDEF}SWAP_DISABLED_CHAINS.insert(0, Chain.ZCASH)\n`],
    ['mutating guard condition', `${LDEF}if SWAP_DISABLED_CHAINS.append(Chain.ZCASH): raise ValueError\n`],
  ];
  for (const [name, src] of narrowed) assert.equal(parseGate3Switch(src).zcashDisabled, null, name);
  // ...and a call is only passed over when its root name is defined nowhere (Python stops at the NameError); a guard
  // only raises a builtin exception class nothing rebinds; walrus conditions run code.
  for (const extra of ['import logging as log\nlog.info("loaded")', 'ALIAS = log\nlog.info("loaded")', 'ValueError = setattr\nif True: raise ValueError(SWAP_DISABLED_CHAINS)', 'if (x := 1): raise ValueError()']) {
    assert.equal(parseGate3Switch(`${guarded('Chain.SOL')}${extra}\n`).zcashDisabled, null, extra);
  }
  assert.equal(parseGate3Switch('from x import *\nSWAP_DISABLED_CHAINS = (Chain.SOL,)\nif True: raise ValueError\n').zcashDisabled, null, 'a star import may rebind the exception class');
  // R3-ING-08: it can. The star-imported SWAP_DISABLED_CHAINS object is released when the definition replaces it, and
  // its finaliser rebinds the switch after the store (CPython 3.9, 3.11 and 3.13 end with Chain.ZCASH in it).
  assert.equal(parseGate3Switch('from x import *\nSWAP_DISABLED_CHAINS = (Chain.SOL,)\n').zcashDisabled, null, 'a star import before a constructor-free definition can still change it');

  // Through the collector: the value is null, the source partial and the last determined value kept.
  const prev: ServicesData = {
    gate3: { commitSha: SHA_A, file: 'app/api/swap/constants.py', zcashDisabled: true, line: 18, url: 'https://github.com/brave/gate3/blob/x', checkedAt: EARLIER },
    studies: [],
    studiesCommit: null,
  };
  const r = await services.collect(makeCtx(() => text(`${LDEF}def add(l):\n    l.append(Chain.ZCASH)\nadd(SWAP_DISABLED_CHAINS)\n`), servicesGh({ gate3: 'c'.repeat(40), variations: null })), prev);
  assert.equal(r.data.gate3?.zcashDisabled, null);
  assert.equal(r.data.gate3?.lastDetermined?.zcashDisabled, true);
  assert.equal(r.partial, true);
  // strict allowlist: reason wording. The module has no Chain import, so the first line not accepted is line 1 (the
  // switch itself); this reason carries no line number, so the line is asserted on the gate3 record and its URL.
  assert.ok(r.limitations?.some((l) => /^gate3 at cccccccc: SWAP_DISABLED_CHAINS is assigned before Chain is imported; /.test(l)), 'the limitation says why the value is unknown');
  assert.ok(r.data.gate3?.reason, 'a reason is given');
  assert.equal(r.data.gate3?.line, 1, 'the line that made the value unknown');
  assert.match(r.data.gate3?.url ?? '', /#L1$/);
});

// The statement-splitter unit test that stood here tested the hand-written Python tokenizer, which was replaced by
// the strict constants-module allowlist in parseGate3Switch; the gate3 behaviour tests in this file still apply.

// ---------------------------------------------------------------------------
// R-DOCS: Zendesk article records without a body
// ---------------------------------------------------------------------------

const DOC_1: DocPage = { id: 'zendesk-1', source: 'support', title: 'Zcash support', url: 'https://support.brave.app/hc/1', contentHash: 'h1', updatedAt: '2026-09-01', retrievedAt: EARLIER, zcashStatements: ['Zcash is supported in Brave Wallet.'] };
const DOC_2: DocPage = { id: 'zendesk-2', source: 'support', title: 'Sending tokens', url: 'https://support.brave.app/hc/2', contentHash: 'h2', updatedAt: '2026-09-01', retrievedAt: EARLIER, zcashStatements: ['You can send ZEC from a Zcash account.'] };

function docsRoute(opts: { list: unknown[]; search?: unknown[]; article?: (id: string) => Response }): Route {
  return (url) => {
    const one = /\/articles\/(\d+)\.json/.exec(url);
    if (one) return opts.article ? opts.article(one[1]) : text('busy', 503);
    if (url.includes('/categories/')) return json({ articles: opts.list });
    if (url.includes('/search.json')) return json({ results: opts.search ?? [] });
    return text('<main><p>Zcash is supported.</p></main>');
  };
}

test('R-DOCS: a listing whose articles lack bodies keeps every captured statement, archives nothing and is partial', async () => {
  // Same article ids as the captured pages, no body: one title still names Zcash, the other does not.
  const list = [
    { id: 1, title: 'Zcash support', html_url: DOC_1.url, edited_at: '2026-09-01' },
    { id: 2, title: 'Sending tokens', html_url: DOC_2.url, edited_at: '2026-09-01' },
  ];
  const r = await docs.collect(makeCtx(docsRoute({ list })), { pages: [DOC_1, DOC_2], history: [] });
  assert.equal(r.partial, true, 'an API shape change is not a clean refresh');
  assert.deepEqual(r.data.history, [], 'nothing archived as reworded or superseded');
  for (const old of [DOC_1, DOC_2]) {
    const kept = r.data.pages.find((p) => p.id === old.id);
    assert.deepEqual(kept, old, `${old.id}: last captured copy kept unchanged`);
  }
  assert.ok(r.limitations?.some((l) => /without a body/.test(l)));

  // The direct article look-up answering without a body is just as unknown.
  const direct = await docs.collect(
    makeCtx(docsRoute({ list: [{ id: 3, title: 'Zcash fees', body: '<p>Zcash fees follow ZIP-317.</p>', html_url: 'https://support.brave.app/hc/3' }], article: (id) => json({ article: { id: Number(id), title: 'Sending tokens', html_url: DOC_2.url } }) })),
    { pages: [DOC_2], history: [] },
  );
  assert.equal(direct.partial, true);
  assert.deepEqual(direct.data.history, []);
  assert.deepEqual(direct.data.pages.find((p) => p.id === 'zendesk-2'), DOC_2);

  // A body-less search hit never replaces the readable listing copy of the same article.
  const mixed = await docs.collect(
    makeCtx(docsRoute({ list: [{ id: 1, title: 'Zcash support', body: '<p>Zcash is supported in Brave Wallet.</p>', html_url: DOC_1.url }], search: [{ id: 1, title: 'Zcash support', html_url: DOC_1.url }] })),
    null,
  );
  assert.deepEqual(mixed.data.pages.find((p) => p.id === 'zendesk-1')?.zcashStatements, ['Zcash is supported in Brave Wallet.']);
  assert.equal(mixed.partial, false);

  // Nothing captured before and nothing readable now: a failure, not an empty success.
  await assert.rejects(docs.collect(makeCtx(docsRoute({ list })), null), /without a body/);
});

// The four Help Center pages captured by a live run of the merged code (scratchpad data-live-int/sources/docs.json).
const LIVE_SUPPORT_PAGES: DocPage[] = [
  { id: 'zendesk-26390040705165', source: 'support', title: 'Zcash and Address Types', url: 'https://support.brave.app/hc/en-us/articles/26390040705165-Zcash-and-Address-Types', updatedAt: '2025-04-02T17:12:57Z', contentHash: '35330fe13fa96296', zcashStatements: ['Zcash is a secure digital currency that helps protect your privacy.', 'With Zcash, there are two types of addresses:', 'Transparent addresses: Transactions with transparent addresses, or t-addresses, can be tracked on the Zcash blockchain the same way Bitcoin can.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
  { id: 'zendesk-12747992885389', source: 'support', title: 'What is Brave Wallet?', url: 'https://support.brave.app/hc/en-us/articles/12747992885389-What-is-Brave-Wallet', updatedAt: '2025-11-13T22:16:24Z', contentHash: 'b50a98de04250093', zcashStatements: ['Support transparent and private shielded Zcash transactions.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
  { id: 'zendesk-4415497656461', source: 'support', title: 'Brave Wallet FAQ', url: 'https://support.brave.app/hc/en-us/articles/4415497656461-Brave-Wallet-FAQ', updatedAt: '2024-08-06T14:17:49Z', contentHash: 'e5f7d6f1ad6ac6de', zcashStatements: ['Brave Wallet supports Ethereum, EVM-compatible chains and L2s, Solana, Bitcoin, Zcash, and Filecoin.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
  { id: 'zendesk-12744130666509', source: 'support', title: 'How does Brave Wallet differ from other wallets?', url: 'https://support.brave.app/hc/en-us/articles/12744130666509-How-does-Brave-Wallet-differ-from-other-wallets', updatedAt: '2025-11-13T22:29:09Z', contentHash: '5ddad1adb949605b', zcashStatements: ['Brave Wallet users can buy, receive, and send crypto assets across multiple chains, including Ethereum, EVM compatible chains, and Solana, Zcash, and Bitcoin.'], retrievedAt: '2026-10-08T14:35:45.102Z' },
];
const liveId = (p: DocPage) => Number(p.id.replace('zendesk-', ''));
/** Listing records for the live pages: same ids, titles and URLs, plus the given fields. */
const liveListing = (extra: (p: DocPage) => Record<string, unknown>) => LIVE_SUPPORT_PAGES.map((p) => ({ id: liveId(p), title: p.title, html_url: p.url, edited_at: p.updatedAt, ...extra(p) }));

function assertLiveKept(r: { data: { pages: DocPage[]; history: unknown[] }; partial?: boolean }, label: string) {
  assert.equal(r.partial, true, `${label}: not a clean refresh`);
  assert.deepEqual(r.data.history, [], `${label}: nothing archived (removed, reworded or superseded)`);
  for (const old of LIVE_SUPPORT_PAGES) assert.deepEqual(r.data.pages.find((p) => p.id === old.id), old, `${label}: ${old.id} kept unchanged`);
}

test('R-DOCS (repair): empty bodies and look-ups that contradict the listing never archive the live Help Center statements', async () => {
  const prev = { pages: LIVE_SUPPORT_PAGES, history: [] };
  const empties = ['', '<p></p>', '&nbsp;', ' \n\t ', '<p> <br> </p>'];

  // (a) The listing returns the same ids with an empty body (titles unchanged); the direct look-up is busy.
  for (const body of empties) {
    const r = await docs.collect(makeCtx(docsRoute({ list: liveListing(() => ({ body })) })), prev);
    assertLiveKept(r, `listing body ${JSON.stringify(body)}`);
    assert.ok(r.limitations?.some((l) => /4 Help Center article\(s\) were listed without a body \(missing or empty/.test(l)), JSON.stringify(body));
  }
  // ... and when the direct look-up answers with an empty body too (or the listing has no body at all).
  for (const body of empties) {
    for (const listed of [{ body: '' }, {}]) {
      const r = await docs.collect(makeCtx(docsRoute({ list: liveListing(() => listed), article: (id) => json({ article: { id: Number(id), title: 'x', html_url: 'u', body } }) })), prev);
      assertLiveKept(r, `look-up body ${JSON.stringify(body)}, listing ${JSON.stringify(listed)}`);
    }
  }

  // (b) Listed as published (body missing or empty), but the direct look-up answers 404, 410 or draft: conflicting
  // answers in one run are unknown, not a removal.
  const lookups: [string, (id: string) => Response][] = [
    ['404', () => text('nf', 404)],
    ['410', () => text('gone', 410)],
    ['draft', (id) => json({ article: { id: Number(id), draft: true, title: 'x', html_url: 'u', body: '<p>Draft text.</p>' } })],
  ];
  for (const [label, article] of lookups) {
    for (const listed of [{}, { body: '' }, { body: null }]) {
      const r = await docs.collect(makeCtx(docsRoute({ list: liveListing(() => listed), article })), prev);
      assertLiveKept(r, `listed ${JSON.stringify(listed)}, look-up ${label}`);
      assert.ok(r.limitations?.some((l) => /listed as published, but the article look-up/.test(l)), label);
    }
  }

  // Unchanged: an article missing from both listing and search that answers 404 is archived as removed; one listed
  // as a draft that answers 404 likewise; a readable body without Zcash wording is a real rewording.
  const elsewhere = { id: 999, title: 'Zcash fees', html_url: 'https://support.brave.app/hc/999', body: '<p>Zcash fees follow ZIP-317.</p>' };
  const gone = await docs.collect(makeCtx(docsRoute({ list: [elsewhere], article: () => text('nf', 404) })), prev);
  assert.deepEqual(gone.data.history.map((h) => [h.id, h.state]), LIVE_SUPPORT_PAGES.map((p) => [p.id, 'removed']));
  assert.equal(gone.partial, false);
  const drafted = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, ...liveListing(() => ({ draft: true }))], article: () => text('nf', 404) })), prev);
  assert.deepEqual(drafted.data.history.map((h) => h.state), ['removed', 'removed', 'removed', 'removed']);
  const reworded = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, ...liveListing(() => ({ title: 'Wallet basics', body: '<p>Brave Wallet supports many chains.</p>' }))] })), prev);
  assert.equal(reworded.partial, false);
  assert.deepEqual(reworded.data.history.map((h) => h.state), ['no-longer-mentions-zcash', 'no-longer-mentions-zcash', 'no-longer-mentions-zcash', 'no-longer-mentions-zcash']);

  // An unrelated Wallet article with an empty body (never captured, title without Zcash) does not make a clean run partial.
  const unrelated = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, { id: 5, title: 'Backing up your wallet', html_url: 'u', body: '' }] })), null);
  assert.equal(unrelated.partial, false);
  // With nothing captured before, a Zcash-titled article with an empty body is not captured as an empty page.
  const emptyNew = await docs.collect(makeCtx(docsRoute({ list: [elsewhere, { id: 6, title: 'Zcash shielding', html_url: 'u', body: '<p></p>' }] })), null);
  assert.equal(emptyNew.partial, true);
  assert.equal(emptyNew.data.pages.some((p) => p.id === 'zendesk-6'), false);
});

// ---------------------------------------------------------------------------
// R-STUDY-SCOPE / R-STUDY-REASON: brave-variations studies
// ---------------------------------------------------------------------------

// Shape of brave-variations studies/iOSWalletWebUIStudy.json5: a wallet-UI study and a Zcash study in one file.
const IOS_WALLET_FILE = `[
  { name: 'iOSWalletWebUIStudy',
    experiment: [ { name: 'Enabled', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletWebUIFeature', 'BraveWalletCardano' ] } } ],
    filter: { min_version: '146.1.89.116', max_version: '152.*', channel: [ 'NIGHTLY', 'BETA' ], platform: [ 'IOS' ] } },
  { name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding',
    experiment: [
      { name: 'EnabledWithShielding', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletZCash' ] }, param: [ { name: 'zcash_shielded_transactions_enabled', value: 'true' } ] },
      { name: 'Default', probability_weight: 0 },
    ],
    filter: { min_version: '146.1.89.116', max_version: '152.*', channel: [ 'NIGHTLY', 'BETA' ], platform: [ 'IOS' ] } },
  { name: 'iOSWalletWebUIStudy',
    experiment: [ { name: 'Enabled', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletWebUIFeature', 'BraveWalletCardano' ] } }, { name: 'Default', probability_weight: 0 } ],
    filter: { min_version: '147.1.89.144', max_version: '152.*', channel: [ 'RELEASE' ], platform: [ 'IOS' ] } },
  { name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding',
    experiment: [
      { name: 'EnabledWithShielding', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletZCash' ] }, param: [ { name: 'zcash_shielded_transactions_enabled', value: 'true' } ] },
      { name: 'Default', probability_weight: 0 },
    ],
    filter: { min_version: '147.1.89.144', max_version: '152.*', channel: [ 'RELEASE' ], platform: [ 'IOS' ] } },
]`;
const blob = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const filesRoute = (files: Record<string, string>): Route => (url) => {
  if (url.includes('gate3')) return text(GATE3_ON);
  const body = files[decodeURIComponent(url.split('/').pop()!)];
  return body === undefined ? text('nf', 404) : text(body);
};
/** Listing digest as computed under an earlier STUDY_RULES value. */
function digestWithRules(rules: number, files: { name: string; sha: string }[]): string {
  const h = createHash('sha256').update(`rules=${rules}\n`);
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) h.update(`${f.name}\t${f.sha}\n`);
  return h.digest('hex');
}
const WALLET_UI_STUDY: StudyInfo = {
  file: 'iOSWalletWebUIStudy.json5',
  name: 'iOSWalletWebUIStudy',
  features: { enable: ['BraveWalletWebUIFeature', 'BraveWalletCardano'], disable: [] },
  params: {},
  minVersion: '146.1.89.116',
  maxVersion: '152.*',
  channels: ['NIGHTLY', 'BETA'],
  platforms: ['IOS'],
  probability: 100,
  appliesTo: [],
  url: `https://github.com/brave/brave-variations/blob/${SHA_B}/studies/iOSWalletWebUIStudy.json5`,
  experiments: [{ name: 'Enabled', weight: 100, share: 100, enable: ['BraveWalletWebUIFeature', 'BraveWalletCardano'], disable: [], params: {} }],
  filter: { min_version: '146.1.89.116', max_version: '152.*', channel: ['NIGHTLY', 'BETA'], platform: ['IOS'] },
  readAt: EARLIER,
};
const ZCASH_IOS_STUDY: StudyInfo = {
  ...WALLET_UI_STUDY,
  name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding',
  features: { enable: ['BraveWalletZCash'], disable: [] },
  params: { zcash_shielded_transactions_enabled: 'true' },
  experiments: [
    { name: 'EnabledWithShielding', weight: 100, share: 100, enable: ['BraveWalletZCash'], disable: [], params: { zcash_shielded_transactions_enabled: 'true' } },
    { name: 'Default', weight: 0, share: 0, enable: [], disable: [], params: {} },
  ],
};

test('R-STUDY-SCOPE: only studies that set Zcash features or parameters are listed, also from earlier data', async () => {
  // Study-level matcher: wallet features alone do not count; Zcash feature, param name or param value does.
  assert.equal(isRelevantStudy({ name: 'W', experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletWebUIFeature', 'BraveWalletCardano'] } }] }), false);
  assert.equal(isRelevantStudy({ name: 'P', experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletPolkadot'] }, param: [{ name: 'wallet_mode', value: 'on' }] }] }), false);
  assert.equal(isRelevantStudy({ name: 'Z', experiment: [{ name: 'On', probability_weight: 100, feature_association: { forcing_feature_on: 'BraveWalletZCash' } }] }), true);
  assert.equal(isRelevantStudy({ name: 'I', experiment: [{ name: 'On', probability_weight: 100, param: [{ name: 'zcash_ironwood_enabled', value: 'true' }] }] }), true);
  assert.equal(isRelevantStudy({ name: 'V', experiment: [{ name: 'On', probability_weight: 100, param: [{ name: 'chains', value: 'eth,zcash' }] }] }), true);

  // The real file shape: two of its four studies touch Zcash.
  const files = { 'iOSWalletWebUIStudy.json5': IOS_WALLET_FILE };
  const listing = Object.entries(files).map(([name, body]) => ({ name, type: 'file', sha: blob(body) }));
  const fresh = await services.collect(makeCtx(filesRoute(files), servicesGh({ listing })), null);
  assert.deepEqual(fresh.data.studies.map((s) => s.name), ['iOSWalletWebUIStudy_ZcashEnabledWithShielding', 'iOSWalletWebUIStudy_ZcashEnabledWithShielding']);

  // Earlier data selected by the old rules, with an unchanged listing: the file is re-read under the new rules.
  const prev: ServicesData = {
    gate3: null,
    studies: [WALLET_UI_STUDY, ZCASH_IOS_STUDY],
    studiesCommit: SHA_B,
    studiesReadAt: EARLIER,
    studiesDigest: digestWithRules(3, listing),
  };
  const ctx = makeCtx(filesRoute(files), servicesGh({ listing }));
  const rerun = await services.collect(ctx, prev);
  assert.ok(ctx.calls.some((u) => u.endsWith('/iOSWalletWebUIStudy.json5')), 'a listing digest from older rules does not skip the re-read');
  assert.equal(rerun.data.studies.some((s) => s.name === 'iOSWalletWebUIStudy'), false);
  assert.equal(rerun.data.studies.filter((s) => s.name === 'iOSWalletWebUIStudy_ZcashEnabledWithShielding').length, 2);

  // brave-variations unreachable: the Zcash study is kept, the wallet-UI study is not carried.
  const down = await services.collect(makeCtx(() => text(GATE3_ON), servicesGh({ variations: null })), prev);
  assert.equal(down.partial, true);
  assert.deepEqual(down.data.studies.map((s) => s.name), ['iOSWalletWebUIStudy_ZcashEnabledWithShielding']);
  assert.ok(down.limitations?.some((l) => /iOSWalletWebUIStudy\b/.test(l) && /no cohort sets a Zcash/.test(l)));
});

const DESKTOP = ['windows-x64', 'windows-x86', 'windows-arm64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
function cv(channel: ChannelVersion['channel'], platform: ChannelVersion['platform'], version: string, detail?: Record<string, string>): ChannelVersion {
  return { channel, platform, version, tag: `v${version}`, publishedAt: null, basis: 'fixture', url: 'https://versions.brave.com/', ...(detail ? { detail } : {}) };
}
const release = (version: string, channel: string, chromium: string | null) => ({ tag: `v${version}`, version, channel, name: `${channel} v${version}`, chromium, publishedAt: null, url: 'u', assetPlatforms: [], prereleaseFlag: false });
const desktopDetail = (channel: string, version: (os: string) => string) => Object.fromEntries(DESKTOP.map((os) => [`${channel}-${os}`, version(os)]));

test('R-STUDY-REASON: per-OS desktop reasons are summarised once per clause instead of repeated per OS', async () => {
  const envs = {
    'brave-versions': env('brave-versions', {
      current: [
        cv('release', 'desktop', '1.97.56', desktopDetail('release', () => '1.97.56')),
        cv('beta', 'desktop', '1.98.47', desktopDetail('beta', (os) => (os === 'linux-x64' ? '1.98.47' : '1.98.52'))),
        cv('nightly', 'desktop', '1.99.25', desktopDetail('nightly', () => '1.99.25')),
        cv('release', 'android', '1.97.56'),
      ],
      missing: [],
    }),
    'brave-releases': env('brave-releases', {
      releases: [release('1.97.56', 'release', '155.0.1.1'), release('1.98.47', 'beta', '155.0.1.1'), release('1.98.52', 'beta', '155.0.1.1'), release('1.99.25', 'nightly', null)],
      latest: [],
      unrecognized: [],
    }),
  };
  const files = {
    'iOSWalletWebUIStudy.json5': IOS_WALLET_FILE,
    'ZcashWindows.json5': JSON.stringify([{ name: 'ZcashWindows', filter: { platform: ['WINDOWS'], channel: ['RELEASE'], min_version: '155.1.97.0' }, experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }]),
    'ZcashNightlyRange.json5': JSON.stringify([{ name: 'ZcashNightlyRange', filter: { channel: ['NIGHTLY'], min_version: '155.1.99.0' }, experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }]),
  };
  const listing = Object.entries(files).map(([name, body]) => ({ name, type: 'file', sha: blob(body) }));
  const r = await services.collect(makeCtx(filesRoute(files), servicesGh({ listing }), envs), null);
  const ios = r.data.studies.find((s) => s.name === 'iOSWalletWebUIStudy_ZcashEnabledWithShielding')!;
  const at = (channel: string) => ios.appliesTo.find((a) => a.platform === 'desktop' && a.channel === channel)!;

  assert.equal(at('release').reason, 'platform filter (IOS) excludes Desktop (all 7 OS builds); channel filter (NIGHTLY, BETA) excludes release; 155.1.97.56 is outside the version range 146.1.89.116 – 152.*');
  assert.equal(at('beta').reason, 'platform filter (IOS) excludes Desktop (all 7 OS builds); 155.1.98.52 (Windows, macOS, Linux arm64) and 155.1.98.47 (Linux x64) are outside the version range 146.1.89.116 – 152.*');
  for (const s of r.data.studies) {
    for (const a of [...s.appliesTo, ...(s.appliesUnknown ?? [])]) {
      assert.ok((a.reason ?? '').length <= 300, `bounded reason: ${a.build}: ${a.reason}`);
      const clauses = (a.reason ?? '').split('; ');
      assert.equal(new Set(clauses).size, clauses.length, `no repeated clause: ${a.reason}`);
    }
  }
  // The iOS-only platform filter decides the desktop nightly builds even though their Chromium version is unknown.
  assert.equal(at('nightly').reason, 'platform filter (IOS) excludes Desktop (all 7 OS builds)');

  // A clause that concerns only some OSes of the group names them; clauses keep the evaluation order.
  const win = r.data.studies.find((s) => s.name === 'ZcashWindows')!;
  assert.deepEqual(
    win.appliesTo.filter((a) => a.platform === 'desktop' && a.channel === 'release').map((a) => [a.build, a.applies, a.reason]),
    [
      ['Desktop release (Windows) 1.97.56 (155.1.97.56)', true, 'platform, channel and version filters admit this build'],
      ['Desktop release (macOS, Linux) 1.97.56 (155.1.97.56)', false, 'platform filter (WINDOWS) excludes Desktop macOS, Linux'],
    ],
  );
  assert.equal(win.appliesTo.find((a) => a.platform === 'desktop' && a.channel === 'nightly')?.reason, 'platform filter (WINDOWS) excludes Desktop macOS, Linux; channel filter (RELEASE) excludes nightly');

  // Undeterminable desktop builds are summarised the same way.
  const range = r.data.studies.find((s) => s.name === 'ZcashNightlyRange')!;
  assert.deepEqual(
    range.appliesUnknown?.filter((a) => a.platform === 'desktop').map((a) => [a.build, a.reason]),
    [['Desktop nightly 1.99.25', 'the Chromium-based version of 1.99.25 is not known, so the version range 155.1.99.0 – any cannot be checked']],
  );
});

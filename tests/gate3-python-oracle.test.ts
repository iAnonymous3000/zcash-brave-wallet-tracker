// Cross-check of the hand-written gate3 reader (parseGate3Switch in src/ingest/sources/services.ts) against an oracle
// built on Python's own parser (tests/fixtures/gate3_oracle.py: ast.parse plus a compile() whose code object is
// discarded; the module is never run).
//
// Invariant, per input:
//   oracle null        -> the hand reader must say null;
//   oracle true/false  -> the hand reader must say the same value, or null (it may be more cautious, never opposite).
//
// Corpus: the real gate3 app/api/swap/constants.py (brave/gate3 at 173a2408, the commit data/sources/brave-services.json
// last recorded; the JSON keeps only metadata, so the file is copied from a clone of that commit, git blob d89bf382),
// every string the other test files pass to parseGate3Switch (tests/fixtures/gate3-corpus/test-inputs.json, recorded
// by capture-test-inputs.mjs), and the variants generated below.
//
// Known violations: tests/fixtures/gate3-corpus/known-violations.json lists, by exact input, the findings this
// cross-check made in parseGate3Switch that this branch may not fix (services.ts is out of its scope). Only four kinds
// may be listed, all "the hand reader is determinate where the oracle's grammar says unknown"; an opposite value, a
// determinate answer on a module Python rejects, or a missed rebinding can never be listed. Any violation not listed
// fails, and so does a listed one that no longer occurs exactly as recorded (fixed in services.ts: delete the entry).
// The list is printed by its own test on every run.
//
// Needs python3 >= 3.9 (GATE3_ORACLE_PYTHON overrides the interpreter). Without it the tests fail when CI is set
// (any value but empty, "0" or "false") and are skipped, with the reason shown, otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGate3Switch } from '../src/ingest/sources/services.ts';

type Verdict = boolean | null;
interface OracleResult {
  zcashDisabled: Verdict;
  reason: string | null;
}

const ORACLE = fileURLToPath(new URL('./fixtures/gate3_oracle.py', import.meta.url));
const CORPUS = new URL('./fixtures/gate3-corpus/', import.meta.url);
const PYTHON = process.env.GATE3_ORACLE_PYTHON || 'python3';
/** Whether a CI environment variable value means "running in CI": unset, empty, "0" and "false" (any case) do not. */
function ciIsSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}
const IN_CI = ciIsSet(process.env.CI);
const S = 'SWAP_DISABLED_CHAINS';

// ---- python3 ----------------------------------------------------------------------------------------------------

function probePython(): { ok: true; version: string } | { ok: false; why: string } {
  const r = spawnSync(PYTHON, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error) return { ok: false, why: `${PYTHON} could not be started (${r.error.message})` };
  if (r.status !== 0) return { ok: false, why: `${PYTHON} exited with status ${r.status}: ${r.stderr.trim()}` };
  const version = r.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 3 || (major === 3 && minor >= 9))) return { ok: false, why: `${PYTHON} is Python ${version}; the oracle needs 3.9 or later` };
  return { ok: true, version };
}

const PY = probePython();
const skip: string | false =
  PY.ok || IN_CI ? false : `SKIPPED - gate3 Python-oracle cross-check not run: ${PY.why}. Install python3 >= 3.9 (or set GATE3_ORACLE_PYTHON); when CI is set (to anything but empty, "0" or "false") this is a failure instead of a skip.`;
if (skip) console.warn(`[gate3-python-oracle] ${skip}`);
const requirePython = () => {
  if (!PY.ok) assert.fail(`gate3 Python oracle unavailable${IN_CI ? ' (CI is set, so this fails instead of skipping)' : ''}: ${PY.why}`);
};

// ---- running the oracle ----------------------------------------------------------------------------------------------

const MAX_BUFFER = 1 << 28;

function parseOracleLine(line: string): OracleResult {
  const r = JSON.parse(line) as OracleResult;
  assert.ok(r.zcashDisabled === true || r.zcashDisabled === false || r.zcashDisabled === null, `oracle output ${line}`);
  assert.ok(r.reason === null || typeof r.reason === 'string', `oracle output ${line}`);
  return r;
}

/** One module on stdin, the documented interface. A Python killed by a signal (a crash in its own compiler) could not compile the module. */
function oracleSingle(src: string): OracleResult {
  const r = spawnSync(PYTHON, ['-I', '-W', 'ignore', ORACLE], { input: Buffer.from(src, 'utf8'), maxBuffer: MAX_BUFFER, timeout: 120_000 });
  if (r.error) throw r.error;
  if (r.signal) return { zcashDisabled: null, reason: `Python was killed by ${r.signal} while compiling the module` };
  if (r.status !== 0) throw new Error(`gate3 oracle failed (status ${r.status}) on ${preview(src)}: ${r.stderr.toString()}`);
  return parseOracleLine(r.stdout.toString().trim());
}

/** Many modules through --batch; a chunk whose process dies or answers short is rerun one module at a time. */
function oracleMany(inputs: string[]): OracleResult[] {
  const CHUNK = 250;
  const out: OracleResult[] = [];
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const chunk = inputs.slice(i, i + CHUNK);
    const body = chunk.map((s) => Buffer.from(s, 'utf8').toString('base64')).join('\n') + '\n';
    const r = spawnSync(PYTHON, ['-I', '-W', 'ignore', ORACLE, '--batch'], { input: body, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 300_000 });
    const lines = r.error || r.status !== 0 ? [] : r.stdout.split('\n').filter(Boolean);
    out.push(...(lines.length === chunk.length ? lines.map(parseOracleLine) : chunk.map(oracleSingle)));
  }
  return out;
}

// ---- the invariant ------------------------------------------------------------------------------------------------

/** No lone surrogates (String.prototype.isWellFormed is outside this project's ES2023 lib). */
const wellFormed = (s: string) => !/\p{Surrogate}/u.test(s);

function preview(src: string): string {
  return JSON.stringify(src.length > 400 ? `${src.slice(0, 200)}…[${src.length} chars]…${src.slice(-150)}` : src);
}

interface Checked {
  src: string;
  label: string;
  oracle: OracleResult;
  hand: ReturnType<typeof parseGate3Switch>;
}

/**
 * Kinds of violation. The first four are findings this branch reports but may not fix (services.ts is out of its
 * scope), so they may be listed in known-violations.json; the others may never be listed.
 */
const KIND = {
  element: 'kind 1: hand reader determinate on a collection with an element that is not a Chain.X read',
  call: 'kind 2: hand reader determinate on a set()/tuple()/list() call (only frozenset(...) is in the grammar)',
  bare: 'kind 3: hand reader determinate beside a bare annotation of the switch (a Store-context target for the oracle)',
  dict: 'kind 4: hand reader determinate on a dict display ({} or frozenset({}) and the like)',
  opposite: 'OPPOSITE VALUE',
  rejected: 'hand reader determinate on a module this Python rejects',
  literal: "hand reader determinate on another value outside the oracle's literal grammar",
  rebound: 'hand reader determinate where the oracle sees the switch rebound or changed',
} as const;
type Kind = (typeof KIND)[keyof typeof KIND];
const LISTABLE: ReadonlySet<Kind> = new Set([KIND.element, KIND.call, KIND.bare, KIND.dict]);

/** Triage of a violation by what the oracle saw, so a failure says at once which kind it is. */
function violationKind(o: OracleResult): Kind {
  const why = o.reason ?? '';
  if (o.zcashDisabled !== null) return KIND.opposite;
  if (/does not parse or compile/.test(why)) return KIND.rejected;
  const literal = /is not a literal tuple\/list\/set\/frozenset\(\.\.\.\) of Chain\.X members: (.*)$/s.exec(why)?.[1];
  if (literal !== undefined) {
    if (/^a call to \S+\(\) \(only frozenset/.test(literal)) return KIND.call;
    if (/^a dict display$/.test(literal)) return KIND.dict;
    if (/^element \d+ \(\w+\) is not a Chain\.X attribute read$/.test(literal)) return KIND.element;
    return KIND.literal;
  }
  const extra = [...why.matchAll(/line \d+: ([^,)]+(?:\([^)]*\))?)/g)].map((m) => m[1]).filter((how) => !/^an? (annotated )?assignment$/.test(how));
  if (/^SWAP_DISABLED_CHAINS is bound \d+ time/.test(why) && extra.length && extra.every((how) => how.startsWith('a bare annotation'))) return KIND.bare;
  return KIND.rebound;
}

function isViolation(c: Checked): boolean {
  const o = c.oracle.zcashDisabled;
  const h = c.hand.zcashDisabled;
  return o === null ? h !== null : h !== null && h !== o;
}

function describe(c: Checked): string {
  return `[${violationKind(c.oracle)}] ${c.label}\n    input:  ${preview(c.src)}\n    hand:   ${JSON.stringify(c.hand.zcashDisabled)} (${c.hand.reason ?? 'no reason'})\n    oracle: ${JSON.stringify(c.oracle.zcashDisabled)} (${c.oracle.reason ?? 'no reason'})`;
}

/**
 * Runs both readers over `cases`. Inputs that are not well-formed UTF-16 (lone surrogates) cannot be handed to Python
 * as the same module and are excluded; the collector never produces them (it decodes the fetched bytes as UTF-8).
 */
function crossCheck(cases: { src: string; label: string }[]) {
  const usable = cases.filter((c) => wellFormed(c.src));
  const results = oracleMany(usable.map((c) => c.src));
  const checked: Checked[] = usable.map((c, i) => ({ ...c, oracle: results[i], hand: parseGate3Switch(c.src) }));
  const violations = checked.filter(isViolation);
  const tally = (pick: (c: Checked) => Verdict) => ({
    true: checked.filter((c) => pick(c) === true).length,
    false: checked.filter((c) => pick(c) === false).length,
    null: checked.filter((c) => pick(c) === null).length,
  });
  return { checked, excluded: cases.length - usable.length, violations, oracle: tally((c) => c.oracle.zcashDisabled), hand: tally((c) => c.hand.zcashDisabled) };
}

// ---- known violations ---------------------------------------------------------------------------------------------

interface KnownViolation {
  kind: string;
  hand: boolean;
  oracle: null;
  labels: string[];
  src: string;
}
const KNOWN_FILE = 'tests/fixtures/gate3-corpus/known-violations.json';
const KNOWN = (JSON.parse(readFileSync(new URL('known-violations.json', CORPUS), 'utf8')) as { findings: KnownViolation[] }).findings;
const KNOWN_BY_SRC = new Map(KNOWN.map((k) => [k.src, k]));

/** Whether a violation is listed exactly as it occurs: same input, same hand verdict, same kind, and a listable kind. */
function listedAs(c: Checked): KnownViolation | null {
  const k = KNOWN_BY_SRC.get(c.src);
  return k && k.hand === c.hand.zcashDisabled && k.oracle === null && c.oracle.zcashDisabled === null && k.kind === violationKind(c.oracle) && LISTABLE.has(k.kind as Kind) ? k : null;
}

function assertOnlyKnownViolations(what: string, r: ReturnType<typeof crossCheck>) {
  const unlisted = r.violations.filter((c) => !listedAs(c));
  const kinds = new Map<string, number>();
  for (const c of unlisted) kinds.set(violationKind(c.oracle), (kinds.get(violationKind(c.oracle)) ?? 0) + 1);
  const summary = [...kinds].map(([kind, n]) => `  ${n} x ${kind}`).join('\n');
  const listed = r.violations.length - unlisted.length;
  assert.equal(
    unlisted.length,
    0,
    `${unlisted.length} of ${r.checked.length} ${what} break the invariant (oracle null => hand null; oracle true/false => hand same or null) and are not listed, as they occur, in ${KNOWN_FILE}${listed ? ` (${listed} listed ones also occur here)` : ''}:\n${summary}\n\n${unlisted.map(describe).join('\n\n')}\n`,
  );
}

// ---- corpus: real file and inputs from the other tests ------------------------------------------------------------

const REAL = readFileSync(new URL('real-constants-173a2408.py', CORPUS), 'utf8');
const REAL_DEF = `${S}: frozenset[Chain] = frozenset({Chain.ZCASH})`;
const TEST_INPUTS = (JSON.parse(readFileSync(new URL('test-inputs.json', CORPUS), 'utf8')) as { inputs: string[] }).inputs;

// ---- corpus: generated variants -----------------------------------------------------------------------------------

const IMPORT = 'from app.api.common.models import Chain\n';
/** `$S` stands for SWAP_DISABLED_CHAINS in the snippets below. */
const named = (s: string) => s.replaceAll('$S', S);

interface Base {
  name: string;
  head: string;
  def: string;
  value: boolean;
}
const realAt = REAL.indexOf(REAL_DEF);
const BASES: Base[] = [
  { name: 'real gate3 file (annotated frozenset, ZCASH in)', head: REAL.slice(0, realAt), def: REAL_DEF, value: true },
  { name: 'tuple without ZCASH', head: IMPORT, def: `${S} = (Chain.ETH, Chain.SOL)`, value: false },
  { name: 'list with ZCASH', head: IMPORT, def: `${S} = [Chain.SOL, Chain.ZCASH]`, value: true },
  { name: 'empty frozenset()', head: IMPORT, def: `${S} = frozenset()`, value: false },
];

interface Case {
  src: string;
  label: string;
  /** What the oracle must answer, when that does not depend on the Python version: a check on the oracle itself. */
  expect?: Verdict;
}

const around = (b: Base, before: string, after: string) => `${b.head}${before ? `${named(before)}\n` : ''}${b.def}\n${after ? `${named(after)}\n` : ''}`;

/** Snippets placed after (and, for most, also before) the definition. `null` = makes the switch unknown; `'keep'` = leaves the definition's value; `undefined` = depends on the Python version. */
type Effect = null | 'keep' | undefined;

const REBINDINGS: [string, Effect][] = [
  ['$S = (Chain.ZCASH,)', null],
  ['$S = ()', null],
  ['$S += (Chain.ZCASH,)', null],
  ['$S |= {Chain.ZCASH}', null],
  ['$S: frozenset[Chain] = frozenset({Chain.ZCASH})', null],
  ['$S: frozenset[Chain]', null],
  ['del $S', null],
  ['global $S', null],
  ['($S := (Chain.ZCASH,))', null],
  ['X = [($S := c) for c in (Chain.ZCASH,)]', null],
  ['for $S in ((Chain.ZCASH,),): pass', null],
  ['with open(__file__) as $S: pass', null],
  ['import $S', null],
  ['import $S.sub', null],
  ['import app.overrides as $S', null],
  ['from app.overrides import $S', null],
  ['from app.overrides import ZCASH_ONLY as $S', null],
  ['from app.overrides import (\n    OTHER,\n    $S,\n)', null],
  ['try:\n    pass\nexcept Exception as $S:\n    pass', null],
  ['match 1:\n    case $S:\n        pass', null],
  ['match {}:\n    case {**$S}:\n        pass', null],
  ['match []:\n    case [*$S]:\n        pass', null],
  ['type $S = tuple', null],
  ['class $S: pass', null],
  ['def $S(): pass', null],
  ['async def $S(): pass', null],
  ['A, $S = 1, (Chain.ZCASH,)', null],
  ['[$S] = [(Chain.ZCASH,)]', null],
  ['*$S, = (Chain.ZCASH,)', null],
  ['A = $S = (Chain.ZCASH,)', null],
  ['$S = A = (Chain.ZCASH,)', null],
  ['if True:\n    $S = (Chain.ZCASH,)', null],
  ['if True: $S = (Chain.ZCASH,)', null],
  ['if False: pass\nelse: $S = (Chain.ZCASH,)', null],
  ['while False:\n    $S = ()', null],
  ['try:\n    $S = (Chain.ZCASH,)\nexcept Exception:\n    pass', null],
  ['with ctx():\n    $S = ()', null],
  ['def f():\n    global $S\n    $S = (Chain.ZCASH,)\nf()', null],
  ['class C:\n    global $S\n    $S = (Chain.ZCASH,)', null],
  ['def f():\n    def g():\n        nonlocal $S\n        $S = ()\n    $S = 1', null],
  ["setattr(sys.modules[__name__], '$S', (Chain.ZCASH,))", null],
  ["globals()['$S'] = (Chain.ZCASH,)", null],
  ['globals().update($S=(Chain.ZCASH,))', null],
  ["vars()['$S'] = ()", null],
  ["exec('$S = (Chain.ZCASH,)')", null],
  ["eval('0')", null],
  ['sys.modules[__name__].$S = (Chain.ZCASH,)', null],
  ['import sys as _s; _s.modules[__name__].$S = ()', null],
  ['import app.api.swap.constants as me\nme.$S = (Chain.ZCASH,)', null],
  ["__builtins__['frozenset'] = tuple", null],
  ['$S.append(Chain.ZCASH)', null],
  ['$S.add(Chain.ZCASH)', null],
  ['$S.clear()', null],
  ['$S[0] = Chain.ZCASH', null],
  ['del $S[0]', null],
  ['$S.attr = 1', null],
  ['\uff33WAP_DISABLED_CHAINS = (Chain.ZCASH,)', null], // NFKC: a fullwidth S is the same identifier
  ['$S: "frozenset[Chain]"', null], // a bare annotation written as a string
  // Routes to module globals under another name: aliased, imported as another name, or looked up by a string.
  ["from builtins import setattr as s; s(me, '$S', (Chain.ZCASH,))", null],
  ["from builtins import exec as run; run('$S = (Chain.ZCASH,)')", null],
  ['g = globals; g().update($S=(Chain.ZCASH,))', null],
  ["g = globals; g()['SWAP_' + 'DISABLED_CHAINS'] = (Chain.ZCASH,)", null],
  ["from sys import modules; modules[__name__].__setattr__('$S', (Chain.ZCASH,))", null],
  ["type(me).__setattr__(me, '$S', (Chain.ZCASH,))", null],
  ["getattr(builtins, 'exec')('$S = (Chain.ZCASH,)')", null],
  ["import builtins as b; b.exec('$S = (Chain.ZCASH,)')", null],
  ["from builtins import vars as v; v()['$S'] = (Chain.ZCASH,)", null],
  ["from functools import partial; partial(setattr, me)('$S', (Chain.ZCASH,))", null],
  ["from operator import methodcaller; methodcaller('update', $S=(Chain.ZCASH,))(d)", null],
  ["import inspect; inspect.currentframe().f_globals['$S'] = (Chain.ZCASH,)", null],
  ["f = lambda: 0; f.__globals__['$S'] = (Chain.ZCASH,)", null],
  ["exec(compile('$S = (Chain.ZCASH,)', '', 'exec'))", null],
  ['from importlib import import_module; import_module(__name__).__dict__.update($S=(Chain.ZCASH,))', null],
  ['import app.api.swap.constants as me; me.__class__ = Patched', null],
  ['import gc; [d for d in gc.get_referrers($S) if type(d) is dict][0].update($S=(Chain.ZCASH,))', null],
  ["from gc import get_referrers as refs; refs($S)[0]['$S'] = (Chain.ZCASH,)", null],
  ["from operator import setitem; setitem(d, '$S', (Chain.ZCASH,))", null],
  ['import ctypes; ctypes.py_object.from_address(id($S) + 24).value = Chain.ZCASH', null],
  ["import pickle; pickle.loads(b'')", null],
  // The switch changed in place through an unbound method or an alias (list and set definitions are mutable).
  ['list.append($S, Chain.ZCASH)', null],
  ['set.add($S, Chain.ZCASH)', null],
  ['A = $S; A.append(Chain.ZCASH)', null],
  ['add = $S.append\nadd(Chain.ZCASH)', null],
  ['A = [$S]\nA[0].append(Chain.ZCASH)', null],
  ['for a in [$S]: a.append(Chain.ZCASH)', null],
  ['A = $S\nA += [Chain.ZCASH]', null],
  ['A = $S\nA |= {Chain.ZCASH}', null],
  ['A = $S\nA[:] = [Chain.ZCASH]', null],
  ['from bisect import insort; insort($S, Chain.ZCASH)', null],
  ['import operator; operator.iadd($S, [Chain.ZCASH])', null],
  ['list.__init__($S, [Chain.ZCASH])', null],
  // Chain rebound: Chain.X may then not be the enum member (a local class whose ETH is the real ZCASH).
  ['from app.api.common.models import Chain as RealChain\nclass Chain:\n    ETH = RealChain.ZCASH', null],
  ['Chain = FakeChain', null],
  ['import other as Chain', null],
  ['Chain.ETH = Chain.ZCASH', null],
  ['def f():\n    global Chain\n    Chain = FakeChain\nf()', null],
  ['for Chain in (FakeChain,): pass', null],
  ['del Chain', null],
];

const NON_BINDINGS: [string, Effect][] = [
  ['def f():\n    $S = (Chain.ZCASH,)', 'keep'],
  ['def f($S=()): pass', 'keep'],
  ['class C:\n    $S = (Chain.ZCASH,)', 'keep'],
  ['X = [$S for $S in ((Chain.ZCASH,),)]', 'keep'],
  ['X = lambda $S: $S', 'keep'],
  ['X = $S', 'keep'],
  ['Y = Chain.ZCASH in $S', 'keep'],
  ['Z = frozenset($S).union({Chain.ETH})', 'keep'],
  ['W = $S.union({Chain.ETH})', 'keep'],
  ['if Chain.ETH in $S: raise ValueError("ETH must stay routable")', 'keep'],
  ['log.info("$S loaded")', 'keep'],
  ['X = f"{$S}"', 'keep'],
  ['def is_disabled(chain: Chain, *, disabled: frozenset[Chain] = $S) -> bool: ...', 'keep'],
  ["__all__ = ['$S']", 'keep'],
  ['OTHER: frozenset[Chain] = frozenset()', 'keep'],
];

const STAR_IMPORTS: [string, Effect][] = [
  ['from app.overrides import *', null],
  ['from .overrides import *', null],
  ['from . import *', null],
  ['from app.overrides import *  # noqa: F403', null],
  ['from app.overrides import *; X = 1', null],
  ['if TYPE_CHECKING:\n    from app.overrides import *', null],
  ['try:\n    from app.overrides import *\nexcept ImportError:\n    pass', null],
  ['from app.overrides import (*)', null],
  ['def f():\n    from app.overrides import *', null],
  ['class C:\n    from app.overrides import *', null],
  ['# from app.overrides import *', 'keep'],
  ['"""from app.overrides import *"""', 'keep'],
  ['X = "from app.overrides import *"', 'keep'],
];

const COMMENTS_AND_STRINGS: [string, Effect][] = [
  ['# $S = (Chain.ZCASH,)', 'keep'],
  ['#$S=()', 'keep'],
  ['"""$S = (Chain.ZCASH,)"""', 'keep'],
  ["'''\n$S = ()\n'''", 'keep'],
  ['"$S = ()"', 'keep'],
  ['X = "$S = ()"  # $S = ()', 'keep'],
  ['X = """\n$S = (Chain.ZCASH,)\n"""', 'keep'],
  ['X = "\\"$S = ()\\""', 'keep'],
  ["X = r'\\'' # $S = ()", 'keep'],
  ['X = r"\\\\"  # $S = ()', 'keep'],
  ['X = b"$S = ()"', 'keep'],
  ["X = rb'$S = ()'", 'keep'],
  ['X = u"$S"', 'keep'],
  ['X = "#"; Y = "$S = ()"', 'keep'],
  ['X = """a\n$S = ()  # """', 'keep'],
  ['X = "$S = ()\\\n$S = ()"', 'keep'],
  ['X = """"$S = ()""""', null],
  ['X = "unterminated $S = ()', null],
  ["X = '''\n$S = ()", null],
  ['X = 1  # "\n$S = ()', null],
  ["X = 1  # '''\n$S = ()\n# '''", null],
  ['X = f"{1}" "$S = ()"', 'keep'],
  ['X = "a" "b" \'$S = ()\'', 'keep'],
  ['X = ("$S = ()"\n     "$S = (Chain.ZCASH,)")', 'keep'],
];

const CONTINUATIONS: [string, Effect][] = [
  ['X = 1 \\\n    + 2', 'keep'],
  ['X = (1,\n \\\n 2)', 'keep'],
  ['X = \\\n\\\n 1', 'keep'],
  ['X = "abc\\\ndef"', 'keep'],
  ['# comment \\\n$S = ()', null],
  ['X = 1  # \\\n$S = ()', null],
  ['X = 1; \\\n$S = ()', null],
  ['X = 1 \\\n; $S = ()', null],
  ['if X: \\\n    $S = ()', null],
  ['$S \\\n= ()', null],
  ['$S = \\\n    (Chain.ZCASH,)', null],
  ['SWAP_DISABLED_\\\nCHAINS = ()', null],
  ['X = 1 \\', null],
  ['X = 1 \\\n', undefined],
  ['X = 1 \\\n# comment', undefined],
  ['X = 1 \\ \nY = 2', null],
];

const UNCOMPILABLE: string[] = [
  'x = (',
  'def f(:',
  'X = 1 +',
  'return 1',
  'nonlocal x',
  'break',
  'continue',
  'yield 1',
  'await x',
  'from __future__ import braces',
  'from __future__ import annotations',
  'from __future__ import nonexistent_feature',
  'from __future__ import *',
  'def f(a, a): pass',
  'def f(x=1, y): pass',
  'def f(*, **k): pass',
  'def f(__debug__): pass',
  '__debug__ = 1',
  '*a = 1',
  'X = 1\n  Y = 2',
  'if X:\nY = 1',
  'X = 0777',
  'X = 08',
  'X = 1_',
  'X = 1__0',
  'X = 0x',
  'X = 1e',
  'X = "\\x4"',
  'X = "\\u12"',
  'X = "\\N{NOT A REAL CHARACTER NAME}"',
  'X = b"\u00e9"',
  'X = "a" b"b"',
  'print "x"',
  'X = 1 = 2',
  'del f()',
  'f(**a, *b)',
  'f(a=1, b)',
  'X = [1, 2',
  'X = )',
  'X = 1\0',
  '# NUL in a comment \0',
  'class C: return',
  'X = yield',
  'True = 1',
  'None = 1',
  'X = not',
  '@decorator',
  'else: pass',
  'X = 1 if',
  'import',
  'from x import',
  'from x import (a, b',
  'X = Chain.ZCASH.',
  'X = {**a, b}',
  'X = [*a for a in b]',
  'X: int: str = 1',
  'f() = 1',
  '(a, b) += 1',
  'X = 1;;',
  '; X = 1',
  'X = \u00a01',
  'X\u00a0= 1',
  '\u000bX = 1',
  'X = 1 \u2028',
  'def f():\n    x = 1\n    global x',
  'if True:\n\tX = 1\n        Y = 2',
  'X = f"{"',
  'X = f"{}"',
  'X = t"x"',
];

/** Modules that stand on their own (one-liners with ';', and literal shapes of the definition). */
const ONE_LINERS = (b: Base): [string, Effect][] => [
  [`${b.head}X = 1; ${b.def}\n`, 'keep'],
  [`${b.head}${b.def}; X = 1\n`, 'keep'],
  [`${b.head}${b.def};\n`, 'keep'],
  [`${b.head}${b.def}; $S = ()\n`, null],
  [`${b.head}$S = (); ${b.def}\n`, null],
  [`${b.head}import os; ${b.def}\n`, 'keep'],
  [`${b.head}from x import *; ${b.def}\n`, null],
  [`${b.head}${b.def}; from x import *\n`, null],
  [`${b.head}${b.def}\nif X: pass; $S = ()\n`, null],
  [`${b.head}${b.def}\nif X: X = 1; $S = ()\n`, null],
  [`${b.head}${b.def}\nif X: raise ValueError; $S = ()\n`, null],
  [`${b.head}${b.def}\ndef f(): pass; $S = ()\n`, 'keep'],
  [`${b.head}${b.def}\nasync def f(): pass; $S = ()\n`, 'keep'],
  [`${b.head}${b.def}\nclass C: pass; $S = ()\n`, 'keep'],
  [`${b.head}${b.def}\nwhile 0: pass; $S = ()\n`, null],
  [`${b.head}${b.def}\nfor _ in (): pass; $S = ()\n`, null],
  [`${b.head}${b.def}\nwith ctx(): pass; $S = ()\n`, null],
  [`${b.head}${b.def}\ntry: pass; $S = ()\nexcept Exception: pass\n`, null],
  [`${b.head}${b.def}\nif X: pass\nelse: pass; $S = ()\n`, null],
  [`${b.head}${b.def}\nmatch = 1; $S = ()\n`, null],
  [`${b.head}${b.def}\nmatch = 1; X = 2\n`, 'keep'],
  [`${b.head}${b.def}\ncase = 1; X = 2\n`, 'keep'],
  [`${b.head}${b.def}\ntype = 1; X = 2\n`, 'keep'],
  [`${b.head}${b.def}\nX = "a;b"; Y = '$S = ()'\n`, 'keep'],
  [`${b.head}${b.def}\nX = 1  # ; $S = ()\n`, 'keep'],
  [`${b.head}${b.def}\nlambda: 0; $S = ()\n`, null],
  [`${b.head}${b.def}\nX = {1: 2}; $S = ()\n`, null],
  [`${b.head}${b.def}\nX = lambda: 1; $S = ()\n`, null],
  [`${b.head}${b.def}\nX: int = 1; $S = ()\n`, null],
  [`${b.head}${b.def}\nX: int = 1; Y = 2\n`, 'keep'],
  [`${b.head}${b.def}\nX = Y[1:2]; Z = 3\n`, 'keep'],
  [`${b.head}${b.def}\nif X: raise ValueError("a; $S = ()")\n`, 'keep'],
  [`${b.head}${b.def}\nX = 1;;\n`, null],
  [`${b.head}; ${b.def}\n`, null],
];

const LITERAL_SHAPES: [string, Verdict | undefined][] = [
  ['$S = (\n    Chain.ETH,\n    Chain.ZCASH,  # c\n)', true],
  ['$S = frozenset(\n    {\n        Chain.ZCASH,\n    }\n)', true],
  ['$S = Chain.ZCASH,', true],
  ['$S = Chain.ETH, Chain.ZCASH', true],
  ['$S = Chain.ETH, Chain.SOL', false],
  ['$S = ((Chain.ZCASH,))', true],
  ['$S = frozenset(((Chain.ZCASH,)))', true],
  ['$S = frozenset([Chain.ZCASH])', true],
  ['$S = frozenset((Chain.SOL, Chain.ETH))', false],
  ['$S = {Chain.ZCASH, Chain.ZCASH}', true],
  ['$S = [ ]', false],
  ['$S = ( )', false],
  ['$S = (Chain . ZCASH ,)', true],
  ['$S = (Chain.\tZCASH,)', true],
  ['$S = (Chain.ZCASH,)  # Chain.ETH', true],
  ['$S = (Chain.ETH,)  # Chain.ZCASH', false],
  ['$S = (Chain.ZCASH_LEGACY,)', false],
  ['$S = (Chain.Zcash,)', false],
  ['$S = (Chain.\uff3aCASH,)', true],
  ['$S = (Chain.ZCASH, Chain.ETH,)', true],
  ['$S: "frozenset[Chain]" = frozenset({Chain.ZCASH})', true],
  ['$S: Final = (Chain.ZCASH,)', true],
  ['$S: frozenset[Chain] = frozenset()', false],
  ['$S:frozenset[Chain]=frozenset({Chain.ZCASH})', true],
  ['$S = frozenset({Chain.ZCASH},)', true],
  ['$S = frozenset ({Chain.ZCASH})', true],
  ['$S = (\\\n Chain.ZCASH,)', true],
  ['$S = (Chain.\\\nZCASH,)', true],
  ['($S) = (Chain.ZCASH,)', true],
  ['($S): frozenset = (Chain.ZCASH,)', null],
  ['$S = (Chain.ZCASH)', null],
  ['$S = ((Chain.ZCASH))', null],
  ['$S = Chain.ZCASH', null],
  ['$S = frozenset((Chain.ZCASH))', null],
  ['$S = {}', null],
  ['$S = (Chain.ZCASH, OTHER)', null],
  ['$S = (Chain.ZCASH, *OTHER)', null],
  ['$S = [Chain.ZCASH, *OTHER]', null],
  ['$S = (Chain.ETH, OTHER)', null],
  ['$S = (Chain.ETH, *OTHER)', null],
  ['$S = set([Chain.ZCASH])', null],
  ['$S = tuple((Chain.ZCASH,))', null],
  ['$S = list([Chain.ETH])', null],
  ['$S = frozenset({Chain.ZCASH}) | frozenset()', null],
  ['$S = frozenset(OTHER)', null],
  ['$S = frozenset(*OTHER)', null],
  ['$S = frozenset({Chain.ZCASH}, key=1)', null],
  ['$S = (chain.ZCASH,)', null],
  ['$S = (models.Chain.ZCASH,)', null],
  ['$S = ("ZCASH",)', null],
  ['$S = (Chain.ZCASH, 1)', null],
  ['$S = (Chain.ZCASH, Chain.ETH.value)', null],
  ['$S = (Chain.ZCASH for _ in ())', null],
  ['$S = [Chain.ZCASH] * 2', null],
  ['$S = (Chain.ZCASH,) if X else ()', null],
  ['$S = {Chain.ZCASH: 1}', null],
  ['$S = frozenset({})', null],
  ['$S = frozenset({Chain.ZCASH: 1})', null],
  ['$S = set({})', null],
  ['$S = tuple({})', null],
  ['$S = list(())', null],
  ['$S = set()', null],
  ['$S = *OTHER, Chain.ZCASH', null],
  ['$S = Chain.ZCASH, *OTHER', null],
  ['$S = {Chain.ZCASH, *()}', null],
  ['$S = [Chain.ZCASH, ...]', null],
  ['$S = (Chain.ZCASH, None)', null],
  ['$S = (Chain.ZCASH, (Chain.ETH,))', null],
  ['$S = Chain.ETH in X, Chain.ZCASH', null],
  ['$S = (Chain).ZCASH,', true],
  ['$S = frozenset({Chain.ZCASH})\nfrozenset = tuple', null],
  ['$S = frozenset({Chain.ZCASH})\nfrom builtins import tuple as frozenset', null],
  ['$S = frozenset({Chain.ZCASH})\nimport builtins; builtins.frozenset = tuple', null],
  ['$S = (Chain.ZCASH,)\nfrozenset = tuple', true],
  ['frozenset = tuple\n$S = frozenset()', null],
];

/** Files that start with something other than the import: docstrings and comments naming the switch, a BOM, cookies, odd line ends. */
const PROLOGUES: [string, Effect][] = [
  ['"""Swap constants.\n\n$S = (Chain.ZCASH,) disables Zcash.\n"""\n', 'keep'],
  ['# $S = ()\n', 'keep'],
  ['#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n', 'keep'],
  ['# -*- coding: latin-1 -*-\n', 'keep'],
  ['# vim: set fileencoding=ascii :\n', 'keep'],
  ['\ufeff', 'keep'],
  ['\ufeff# coding: utf-8\n', 'keep'],
  ['\ufeff# coding: latin-1\n', null],
  ['# coding: no-such-codec\n', null],
  ['# coding: ascii\n# \u00e9\n', null],
  ['from __future__ import annotations\n', 'keep'],
  ['"""Docs."""\nfrom __future__ import annotations\n', 'keep'],
  ['X = 1\nfrom __future__ import annotations\n', null],
  ['\f', 'keep'],
  ['\n\n\n', 'keep'],
  ['﻿# coding: utf8\n', null],
  ['﻿# coding: UTF_8\n', 'keep'],
  ['# coding=utf8\n', 'keep'],
  ['#!/usr/bin/env python3\n# coding: ascii\n', 'keep'],
  ['X = 1\n# coding: no-such-codec\n', undefined],
  ['b"""Docs."""\nfrom __future__ import annotations\n', null],
  ['u"""Docs."""\nfrom __future__ import annotations\n', 'keep'],
  ['("Docs.")\nfrom __future__ import annotations\n', 'keep'],
  ['"""Docs."""\n"""More."""\nfrom __future__ import annotations\n', null],
];

function variants(): Map<string, Case[]> {
  const cats = new Map<string, Case[]>();
  const add = (cat: string, src: string, label: string, expect?: Verdict) => {
    const list = cats.get(cat) ?? [];
    if (!list.some((c) => c.src === src)) list.push({ src, label: `${cat}: ${label}`, expect });
    cats.set(cat, list);
  };
  const outcome = (effect: Effect, b: Base): Verdict | undefined => (effect === undefined ? undefined : effect === 'keep' ? b.value : null);
  for (const b of BASES) {
    for (const [snippet, effect] of REBINDINGS) {
      // match/type need 3.10/3.12; on older Pythons those modules do not parse, which is null too.
      add('rebinding forms (after the definition)', around(b, '', snippet), `${b.name} + ${snippet}`, outcome(effect, b));
      add('rebinding forms (before the definition)', around(b, snippet, ''), `${snippet} + ${b.name}`, outcome(effect, b));
    }
    for (const [snippet, effect] of NON_BINDINGS) {
      add('local, class-level and read-only uses (no rebinding)', around(b, '', snippet), `${b.name} + ${snippet}`, outcome(effect, b));
    }
    for (const [src, effect] of ONE_LINERS(b)) add("compound one-liners with ';'", named(src), `${b.name}: ${JSON.stringify(named(src).slice(b.head.length))}`, outcome(effect, b));
    for (const [snippet, effect] of STAR_IMPORTS) {
      add('star imports before/after', around(b, '', snippet), `${b.name} + ${snippet}`, outcome(effect, b));
      add('star imports before/after', around(b, snippet, ''), `${snippet} + ${b.name}`, outcome(effect, b));
    }
    for (const [snippet, effect] of COMMENTS_AND_STRINGS) {
      add('comments and strings naming the switch', around(b, '', snippet), `${b.name} + ${snippet}`, outcome(effect, b));
      add('comments and strings naming the switch', around(b, snippet, ''), `${snippet} + ${b.name}`, outcome(effect, b));
    }
    for (const [snippet, effect] of CONTINUATIONS) add('line continuations', around(b, '', snippet), `${b.name} + ${snippet}`, outcome(effect, b));
    for (const snippet of UNCOMPILABLE) {
      // t-strings compile on 3.14+ only, so that one has no version-independent answer.
      const expect = snippet.includes('t"') ? undefined : null;
      add('uncompilable modules', around(b, '', snippet), `${b.name} + ${snippet}`, expect);
    }
    for (const [prologue, effect] of PROLOGUES) add('prologues (docstrings, cookies, BOM)', `${named(prologue)}${b.head}${b.def}\n`, `${JSON.stringify(prologue)} + ${b.name}`, outcome(effect, b));
  }
  for (const [def, expect] of LITERAL_SHAPES) add('literal shapes of the definition', `${IMPORT}${named(def)}\n`, def, expect);
  // Python's universal newlines: CRLF and lone CR line ends.
  for (const b of BASES) {
    const lf = around(b, '# $S = ()', 'X = 1');
    add('line ends', lf.replace(/\n/g, '\r\n'), `${b.name}, CRLF`, b.value);
    add('line ends', lf.replace(/\n/g, '\r'), `${b.name}, CR`, b.value);
  }
  for (const c of mutationFuzz()) add('seeded mutation fuzz', c.src, c.label);
  return cats;
}

/** Inert modules the hand reader answers, used as seeds for mutation: every allowlisted statement form appears. */
const RICH = (members: string) =>
  named(`"""Swap constants: $S = (Chain.ZCASH,) here is documentation."""
from __future__ import annotations

import enum
from app.api.common.models import (
    Chain,
    Provider as P,
)

# $S = () -- the old value
DEFAULT_SLIPPAGE_PERCENTAGE = "0.5"
MAX_RETRIES: int = 3
TIMEOUTS = {"quote": 1.5e1, 'swap': 0x1E, "raw": r"\\d+;#", "bytes": b'\\x00', "u": u"\\u00e9"}
NOTE = """multi-line;
$S = ()  # not code
"""
$S: frozenset[Chain] = frozenset({${members}})
__all__ = ["$S", "DEFAULT_SLIPPAGE_PERCENTAGE"]
if Chain.SOL in $S: raise ValueError("SOL must stay routable; see #12")
def is_disabled(chain: Chain, *, disabled: frozenset[Chain] = $S) -> bool: ...
ROUTABLE = $S.symmetric_difference({Chain.ETH, Chain.SOL})
TOTAL = 1 + \\
    2
log.info("loaded %s", $S)
`);

/** Deterministic PRNG (mulberry32), so every run and every failure message sees the same variants. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tokens and lines the mutations insert: quotes, escapes, separators, keywords, look-alike characters, rebinding forms. */
const FRAGMENTS = [
  '"', "'", '"""', "'''", '\\', '\\\n', ';', ':', '#', '(', ')', '[', ']', '{', '}', ',', '=', ' ', '\t', '\n', '\n    ', '\f', '\r', '\r\n',
  '$S', ' $S = () ', '$S;', '; $S = ()', 'r', 'b', 'f', 'u', 'rb', 'x', '_', '.', '*', '**', '@', ':=', '+=', '0', '0x', '1_', 'e', 'j',
  'if ', 'else', 'lambda ', 'not ', ' in ', ' is ', 'async ', 'await ', 'yield ', 'global ', 'del ', 'match ', 'case ', 'type ', 'pass',
  'from x import *', 'import ', ' as ', ' ', 'é', 'Ｓ', '\0', '\\N{BULLET}', '\\x4', '{{', '}}', 'Chain.ZCASH', 'Chain.ETH, ',
];
const LINES = [...REBINDINGS, ...NON_BINDINGS, ...STAR_IMPORTS, ...COMMENTS_AND_STRINGS, ...CONTINUATIONS].map(([s]) => s).concat(UNCOMPILABLE);

function mutationFuzz(): { src: string; label: string }[] {
  const seeds: [string, string][] = [
    ['rich module, ZCASH in', RICH('Chain.ZCASH, Chain.ETH')],
    ['rich module, ZCASH out', RICH('Chain.ETH')],
    ['real gate3 file', REAL],
  ];
  const out: { src: string; label: string }[] = [];
  const PER_SEED = 220;
  for (const [si, [seedName, seedSrc]] of seeds.entries()) {
    const rand = prng(0x9a7e3 + si);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    for (let n = 0; n < PER_SEED; n++) {
      let src = seedSrc;
      const ops: string[] = [];
      const count = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < count; k++) {
        const at = Math.floor(rand() * (src.length + 1));
        const lines = src.split('\n');
        const li = Math.floor(rand() * lines.length);
        switch (Math.floor(rand() * 8)) {
          case 0: {
            const frag = named(pick(FRAGMENTS));
            src = src.slice(0, at) + frag + src.slice(at);
            ops.push(`insert ${JSON.stringify(frag)} at ${at}`);
            break;
          }
          case 1:
            ops.push(`delete ${JSON.stringify(src[at] ?? '')} at ${at}`);
            src = src.slice(0, at) + src.slice(at + 1);
            break;
          case 2: {
            const frag = named(pick(FRAGMENTS));
            ops.push(`replace ${JSON.stringify(src[at] ?? '')} at ${at} with ${JSON.stringify(frag)}`);
            src = src.slice(0, at) + frag + src.slice(at + 1);
            break;
          }
          case 3:
            ops.push(`duplicate line ${li + 1}`);
            lines.splice(Math.floor(rand() * lines.length), 0, lines[li]);
            src = lines.join('\n');
            break;
          case 4:
            ops.push(`delete line ${li + 1}`);
            lines.splice(li, 1);
            src = lines.join('\n');
            break;
          case 5:
            if (li + 1 < lines.length) [lines[li], lines[li + 1]] = [lines[li + 1], lines[li]];
            ops.push(`swap lines ${li + 1} and ${li + 2}`);
            src = lines.join('\n');
            break;
          case 6: {
            const line = named(pick(LINES));
            lines.splice(li, 0, line);
            ops.push(`insert line ${JSON.stringify(line)} before line ${li + 1}`);
            src = lines.join('\n');
            break;
          }
          default:
            lines[li] = lines[li].startsWith(' ') ? lines[li].trimStart() : `    ${lines[li]}`;
            ops.push(`(de)indent line ${li + 1}`);
            src = lines.join('\n');
        }
      }
      out.push({ src, label: `${seedName}, #${n}: ${ops.join('; ')}` });
    }
  }
  return out;
}

const GENERATED = variants();
const ALL_GENERATED = [...GENERATED.values()].flat();

/** Every corpus the invariant runs over, by name; checked once (lazily) and shared by the tests below. */
const CORPORA = new Map<string, { src: string; label: string }[]>([
  ['real', [{ src: REAL, label: 'real gate3 constants.py' }]],
  ['test-inputs', TEST_INPUTS.map((src, i) => ({ src, label: `test-inputs.json #${i}` }))],
  ...[...GENERATED].map(([cat, cases]): [string, { src: string; label: string }[]] => [cat, cases]),
]);
const checkedCorpora = new Map<string, ReturnType<typeof crossCheck>>();
function checkedCorpus(name: string): ReturnType<typeof crossCheck> {
  let r = checkedCorpora.get(name);
  if (!r) {
    r = crossCheck(CORPORA.get(name)!);
    checkedCorpora.set(name, r);
  }
  return r;
}

// ---- tests --------------------------------------------------------------------------------------------------------

test('gate3 oracle: CI counts as set unless CI is unset, empty, "0" or "false"', () => {
  for (const v of [undefined, '', ' ', '0', 'false', 'False', 'FALSE', ' false ']) assert.equal(ciIsSet(v), false, JSON.stringify(v));
  for (const v of ['1', 'true', 'TRUE', 'yes', 'github-actions']) assert.equal(ciIsSet(v), true, JSON.stringify(v));
});

test('gate3 oracle: python3 >= 3.9 is available', { skip }, () => {
  requirePython();
});

test('gate3 oracle: self-checks on fixed inputs (each unknown category, and determinate controls)', { skip }, () => {
  requirePython();
  const fixed: [string, Verdict][] = [
    [REAL, true],
    [`${IMPORT}${S} = (Chain.ETH,)\n`, false],
    [`${IMPORT}X = 1; ${S} = (Chain.ZCASH,)\n`, true],
    [`# ${S} = ()\n"""${S} = ()"""\n${IMPORT}${S} = [Chain.SOL]\n`, false],
    [`${IMPORT}${S} = (Chain.ETH,)\nX = (\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\n${S} = (Chain.ZCASH,)\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\nif X: ${S} = ()\n`, null],
    [`${IMPORT}from x import *\n${S} = (Chain.ETH,)\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\ndel ${S}\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\ndef f():\n    global ${S}\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\n${S} += ()\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\nfor ${S} in (): pass\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\nwith x as ${S}: pass\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\nimport x as ${S}\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\n[(${S} := 1) for _ in ()]\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\nsetattr(sys.modules[__name__], '${S}', ())\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\nglobals()['${S}'] = ()\n`, null],
    [`${IMPORT}${S} = (Chain.ETH, OTHER)\n`, null],
    [`${IMPORT}${S} = frozenset(load())\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\ndef f():\n    ${S} = (Chain.ZCASH,)\n`, false],
    // Routes under other names, and changes in place through an alias (real Python ends with Zcash disabled).
    [`${IMPORT}${S} = (Chain.ETH,)\nfrom builtins import setattr as s; s(me, '${S}', (Chain.ZCASH,))\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\ng = globals; g()['SWAP_' + 'DISABLED_CHAINS'] = (Chain.ZCASH,)\n`, null],
    [`${IMPORT}${S} = (Chain.ETH,)\ntype(me).__setattr__(me, '${S}', (Chain.ZCASH,))\n`, null],
    [`${IMPORT}${S} = [Chain.ETH]\nlist.append(${S}, Chain.ZCASH)\n`, null],
    [`${IMPORT}${S} = [Chain.ETH]\nA = ${S}; A.append(Chain.ZCASH)\n`, null],
    [`from app.api.common.models import Chain as RealChain\nclass Chain:\n    ETH = RealChain.ZCASH\n${S} = (Chain.ETH,)\n`, null],
    [`${IMPORT}${S} = [Chain.ETH]\nadd = ${S}.append\nadd(Chain.ZCASH)\n`, null],
    // Controls: an unused reflective import, a string that only spells a route, an alias that is never changed, a
    // mutating method stored but never called, Chain bound once by a plain assignment, a bare annotation of Chain
    // (it binds nothing), and Chain as a plain function (Chain.X raises; it cannot be another member).
    [`${IMPORT}import inspect\n${S} = (Chain.ETH,)\n`, false],
    [`${IMPORT}${S} = (Chain.ETH,)\nX = 'exec'\n`, false],
    [`${IMPORT}${S} = [Chain.ETH]\nA = ${S}\n`, false],
    [`${IMPORT}${S} = [Chain.ETH]\nX = ${S}.append\n`, false],
    [`import app.api.common.models as models\nChain = models.Chain\n${S} = (Chain.ZCASH,)\n`, true],
    [`${IMPORT}Chain: type\n${S} = (Chain.ZCASH,)\n`, true],
    [`def Chain(): pass\n${S} = (Chain.ZCASH,)\n`, true],
  ];
  const got = oracleMany(fixed.map(([src]) => src));
  for (const [i, [src, want]] of fixed.entries()) assert.equal(got[i].zcashDisabled, want, `${preview(src)}: ${got[i].reason}`);
});

test('gate3 oracle: the single-module stdin interface agrees with --batch', { skip }, () => {
  requirePython();
  const sample = [REAL, ...TEST_INPUTS.filter((s) => wellFormed(s)).slice(0, 4), ...ALL_GENERATED.filter((_, i) => i % 400 === 0).map((c) => c.src)];
  const batch = oracleMany(sample);
  for (const [i, src] of sample.entries()) assert.deepEqual(oracleSingle(src), batch[i], preview(src));
});

test('gate3 oracle: the real gate3 constants.py (173a2408) reads as Zcash disabled in both readers', { skip }, () => {
  requirePython();
  assert.ok(REAL.includes(`\n${REAL_DEF}\n`), 'the corpus copy still holds the recorded definition');
  const r = checkedCorpus('real');
  assert.equal(r.checked[0].oracle.zcashDisabled, true, `oracle: ${r.checked[0].oracle.reason}`);
  assert.equal(r.checked[0].hand.zcashDisabled, true, `hand: ${r.checked[0].hand.reason}`);
  assert.equal(r.violations.length, 0, 'the real file is never a listed violation');
});

test('gate3 oracle: every parseGate3Switch input from the other test files keeps the invariant', { skip }, () => {
  requirePython();
  assert.ok(TEST_INPUTS.length >= 400, `test-inputs.json holds ${TEST_INPUTS.length} inputs; regenerate it with capture-test-inputs.mjs`);
  assert.ok(TEST_INPUTS.includes(`A = ${S} = ()\n`), 'a literal input of audit-ingest-services.test.ts is in the capture');
  const r = checkedCorpus('test-inputs');
  assert.equal(r.excluded, 0, 'every captured input is well-formed text');
  assert.ok(r.oracle.true >= 20 && r.oracle.false >= 20 && r.oracle.null >= 100, `oracle verdicts are not trivial: ${JSON.stringify(r.oracle)}`);
  assertOnlyKnownViolations('inputs from the existing tests', r);
});

test('gate3 oracle: generated variants are numerous and the oracle answers them as designed', { skip }, () => {
  requirePython();
  assert.ok(ALL_GENERATED.length >= 300, `${ALL_GENERATED.length} generated variants`);
  for (const [cat, cases] of GENERATED) assert.ok(cases.length >= 8, `${cat}: ${cases.length} variants`);
  const expected = ALL_GENERATED.filter((c) => c.expect !== undefined);
  const got = oracleMany(expected.map((c) => c.src));
  const wrong = expected.flatMap((c, i) => (got[i].zcashDisabled === c.expect ? [] : [`${c.label}\n    input: ${preview(c.src)}\n    expected ${c.expect}, oracle ${got[i].zcashDisabled} (${got[i].reason})`]));
  assert.equal(wrong.length, 0, `the oracle disagrees with the variant's designed answer (an oracle bug, not a finding about the hand reader):\n\n${wrong.join('\n\n')}`);
  const verdicts = { true: got.filter((g) => g.zcashDisabled === true).length, false: got.filter((g) => g.zcashDisabled === false).length, null: got.filter((g) => g.zcashDisabled === null).length };
  assert.ok(verdicts.true >= 100 && verdicts.false >= 100 && verdicts.null >= 300, `oracle verdicts are not trivial: ${JSON.stringify(verdicts)}`);
});

for (const [cat, cases] of GENERATED) {
  test(`gate3 oracle: generated variants keep the invariant - ${cat} (${cases.length})`, { skip }, () => {
    requirePython();
    assertOnlyKnownViolations(`variants (${cat})`, checkedCorpus(cat));
  });
}

test(`gate3 oracle: known violations - ${KNOWN.length} findings in parseGate3Switch, each still occurring exactly as listed`, { skip }, (t) => {
  requirePython();
  // The list may only hold the four findings this branch cannot fix, never an opposite value or a rejected module.
  for (const k of KNOWN) {
    assert.equal(k.oracle, null, `a listed violation must have oracle null (an opposite value is never listable): ${preview(k.src)}`);
    assert.ok(typeof k.hand === 'boolean', `a listed violation has a determinate hand verdict: ${preview(k.src)}`);
    assert.ok(LISTABLE.has(k.kind as Kind), `not a listable kind: ${k.kind} (${preview(k.src)})`);
  }
  assert.equal(KNOWN_BY_SRC.size, KNOWN.length, `${KNOWN_FILE} lists an input twice`);
  // Where each listed input occurs as a violation now, across every corpus.
  const seen = new Map<string, { checked: Checked; labels: string[] }>();
  for (const name of CORPORA.keys()) {
    for (const c of checkedCorpus(name).violations) {
      if (!KNOWN_BY_SRC.has(c.src)) continue;
      const entry = seen.get(c.src) ?? { checked: c, labels: [] };
      entry.labels.push(c.label);
      seen.set(c.src, entry);
    }
  }
  const stale: string[] = [];
  for (const k of KNOWN) {
    const now = seen.get(k.src);
    const where = `\n    input:  ${preview(k.src)}\n    listed: ${k.kind}; hand ${k.hand}; ${JSON.stringify(k.labels)}`;
    if (!now) stale.push(`no longer a violation in any corpus (fixed in services.ts, or the input left the corpus): delete it from ${KNOWN_FILE}${where}`);
    else if (!listedAs(now.checked)) stale.push(`occurs differently now (${describe(now.checked)}): update or delete the entry${where}`);
    else if (JSON.stringify([...now.labels].sort()) !== JSON.stringify([...k.labels].sort())) stale.push(`occurs under other labels now (${JSON.stringify(now.labels)}): update the entry's labels${where}`);
  }
  assert.equal(stale.length, 0, `${stale.length} of ${KNOWN.length} listed violations are stale:\n\n${stale.join('\n\n')}\n`);
  // Shown on every run, so the findings stay visible while the suite passes.
  const byKind = new Map<string, KnownViolation[]>();
  for (const k of KNOWN) byKind.set(k.kind, [...(byKind.get(k.kind) ?? []), k]);
  t.diagnostic(`${KNOWN.length} known violations of the invariant, listed in ${KNOWN_FILE} (findings in parseGate3Switch, src/ingest/sources/services.ts, not fixed on this branch):`);
  for (const [kind, ks] of byKind) {
    t.diagnostic(`  ${ks.length} x ${kind}`);
    for (const k of ks) t.diagnostic(`    hand ${k.hand}, oracle null: ${preview(k.src)}`);
  }
});

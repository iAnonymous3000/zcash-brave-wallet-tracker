import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog, parseFeatureFlags, preprocess } from '../src/ingest/parsers.ts';
import { compareSemver, compareVersions, satisfiesRange } from '../src/lib/util.ts';
import { Http, parseRetryAfter } from '../src/lib/http.ts';

const changelogOpts = { platform: 'desktop' as const, file: 'C.md', commitSha: 'fixture', now: '2026-10-09T00:00:00Z' };
const hidden = '- Enabled Zcash Ironwood support by default. ([#56872](https://github.com/brave/brave-browser/issues/56872))';

for (const [label, block] of [
  ['HTML comment', `<!--\n${hidden}\n-->`],
  ['backtick fence', `\x60\x60\x60\n${hidden}\n\x60\x60\x60`],
  ['tilde fence', `~~~text\n${hidden}\n~~~`],
  ['indented code', `    ${hidden}`],
  ['tab-indented code', `\t${hidden}`],
  ['raw HTML block', `<div>\n${hidden}\n</div>`],
  ['preformatted HTML', `<pre>\n${hidden}\n</pre>`],
]) {
  test(`release evidence excludes ${label} contents but resumes after the block`, () => {
    // The paragraph ends the preceding list. Without it, a four-space bullet is a legal nested list.
    const text = `## 1.2.3\n- Zcash shipped\n\nExample:\n\n${block}\n\n- Zcash public note\n`;
    const entries = parseChangelog(text, changelogOpts);
    assert.deepEqual(entries.map((e) => [e.version, e.text]), [['1.2.3', 'Zcash shipped'], ['1.2.3', 'Zcash public note']]);
    assert.equal(entries.some((e) => e.issueRefs.includes('brave/brave-browser#56872')), false);
    assert.equal(entries.at(-1)!.line, text.split('\n').indexOf('- Zcash public note') + 1, 'source lines stay exact');
    assert.deepEqual(parseChangelog(text.replace(/\n/g, '\r\n'), changelogOpts), entries, 'CRLF keeps the same entries and evidence locations');
  });
}

test('real nested list notes remain prose, while code inside a list does not become evidence', () => {
  const text = '## 1.2.3\n- Zcash parent\n  - Zcash child\n\n  ```\n  - Zcash example only\n  ```\n\n- Zcash next\n';
  assert.deepEqual(parseChangelog(text, changelogOpts).map((e) => e.text), ['Zcash parent', 'Zcash child', 'Zcash next']);
  for (const indent of ['    ', '\t']) {
    assert.deepEqual(parseChangelog(`## 1.2.3\n- Zcash parent\n\n${indent}- Zcash nested note\n`, changelogOpts).map((e) => e.text), ['Zcash parent', 'Zcash nested note'], 'indented bullets following a list are not automatically code');
  }
});

const realFeature = 'BASE_FEATURE(kZCashFeature, "https://example.invalid/ZCash", base::FEATURE_ENABLED_BY_DEFAULT);';
const expectedFlag = { name: 'kZCashFeature', kind: 'feature', feature: null, key: 'https://example.invalid/ZCash', defaults: { desktop: true, android: true, ios: true } };

test('preprocessor-shaped comments cannot remove or condition a real feature declaration', () => {
  for (const comment of ['/* comment example:\n#if 0\n*/', '// example \\\n#if 0', '/*\n#if defined(UNKNOWN)\n#endif\n*/']) {
    assert.deepEqual(parseFeatureFlags(`${comment}\n${realFeature}`), [expectedFlag], comment);
    assert.match(preprocess(`${comment}\n${realFeature}`, 'desktop'), /BASE_FEATURE\(kZCashFeature/);
  }
});

test('ordinary and raw C++ string contents cannot invent declarations or preprocessor guards', () => {
  const fake = 'BASE_FEATURE(kFakeZCashFeature, base::FEATURE_ENABLED_BY_DEFAULT);';
  for (const source of [
    `const char* kDocs = "${fake}";`,
    `const char* kDocs = R"docs(${fake})docs";`,
    `const char* kDocs = u8R"docs(\n#if 0\n${fake}\n)docs";`,
    `const char* kDocs = "FeatureParam<bool> kFakeZCashParam{&kZCashFeature, \\"key\\", true};";`,
    `const char* kDocs = R"params(FeatureParam<bool> kFakeZCashParam{&kZCashFeature, "key", true};)params";`,
  ]) {
    assert.deepEqual(parseFeatureFlags(source), [], source);
    assert.deepEqual(parseFeatureFlags(`${source}\n${realFeature}`), [expectedFlag], 'the declaration after a literal remains active');
  }
});

test('actual platform guards and comments between tokens still control real declarations', () => {
  const source = '#if /* explanation */ BUILDFLAG(IS_ANDROID)\nBASE_FEATURE(/* name */ kZCashFeature, "ZCash", base::FEATURE_ENABLED_BY_DEFAULT);\n#else\nBASE_FEATURE(kZCashFeature, "ZCash", base::FEATURE_DISABLED_BY_DEFAULT);\n#endif';
  assert.deepEqual(parseFeatureFlags(source)[0].defaults, { desktop: false, android: true, ios: false });
  assert.deepEqual(parseFeatureFlags('const base::FeatureParam<bool> kZCashParam{&kZCashFeature, "zcash_key", true};')[0].defaults, { desktop: true, android: true, ios: true });
});

test('C++ numeric digit separators stay unsupported guards rather than becoming certain defaults', () => {
  // Both are valid C++: a compiler excludes the first declaration and includes the second. This bounded
  // evaluator does not implement separated integer literals, so it must retain the feature with unknown activity.
  for (const condition of ["1'000 && 0", "0'1", "0xA'F && 0"]) {
    const source = `#if ${condition}\nBASE_FEATURE(kZCashFeature, base::FEATURE_ENABLED_BY_DEFAULT);\n#endif`;
    assert.equal(parseFeatureFlags(source).length, 1, condition);
    assert.deepEqual(parseFeatureFlags(source)[0].defaults, { desktop: null, android: null, ios: null }, condition);
  }
});

test('actual C++ character literals remain opaque while real declarations after them survive', () => {
  for (const literal of [String.raw`'x'`, String.raw`'\"'`, String.raw`'\''`, String.raw`'#'`]) {
    const source = `const auto kDocumentation = ${literal};\n${realFeature}`;
    assert.deepEqual(parseFeatureFlags(source), [expectedFlag], literal);
  }
});

test('arbitrary-length SemVer core integers retain exact precedence and advisory range membership', () => {
  const small = '9007199254740992';
  const large = '9007199254740993';
  for (const [a, b] of [[`${small}.0.0`, `${large}.0.0`], [`1.${small}.0`, `1.${large}.0`], [`1.0.${small}`, `1.0.${large}`], [`${'9'.repeat(500)}.0.0`, `1${'0'.repeat(500)}.0.0`]]) {
    assert.ok(compareSemver(a, b) < 0, `${a} < ${b}`);
    assert.ok(compareVersions(b, a) > 0, 'dotted numeric comparison also retains precision');
    assert.equal(satisfiesRange(a, `= ${b}`), false);
    assert.equal(satisfiesRange(a, `< ${b}`), true);
    assert.equal(satisfiesRange(b, `>= ${b}, <= ${b}`), true);
  }
  assert.equal(compareSemver('1.02', '1.2.0'), 0, 'existing abbreviated/zero-padded core compatibility is retained');
  assert.equal(compareSemver(`${large}.0.0+build.2`, `${large}.0.0+build.1`), 0);
  assert.ok(compareSemver(`${large}.0.0-rc.${small}`, `${large}.0.0-rc.${large}`) < 0);
});

const nowMs = Date.parse('2026-10-08T23:00:00Z');

test('HTTP-date Retry-After recognizes only real weekday tokens in all three supported forms', () => {
  for (const v of ['Abc, 09 Oct 2026 00:00:00 GMT', 'Funday, 09-Oct-26 00:00:00 GMT', 'Abc Oct  9 00:00:00 2026']) assert.equal(parseRetryAfter(v, nowMs), null, v);
  for (const v of ['Fri, 09 Oct 2026 00:00:00 GMT', 'Friday, 09-Oct-26 00:00:00 GMT', 'Fri Oct  9 00:00:00 2026']) assert.equal(parseRetryAfter(v, nowMs), 3_600_000, v);
  assert.equal(parseRetryAfter('3', nowMs), 3000);
});

test('an invalid weekday Retry-After falls back to bounded retry backoff', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http = new Http({ fetch: async () => ++calls === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': 'Abc, 09 Oct 2026 00:00:00 GMT' } }) : new Response('ok'), now: () => nowMs, maxRetries: 1, sleep: async (ms) => void sleeps.push(ms) });
  assert.equal((await http.text('https://example.invalid/')).text, 'ok');
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0 && sleeps[0] < 2000, 'the malformed date does not cause a long deferral');
});

// Regression tests for the site-client audit findings (UI-C1..UI-C8, EXTRA-5).
// The real client (src/site/client/app.ts) is bundled with esbuild exactly as the site build does
// and run in a vm against a small fake DOM, so these tests exercise the shipped behaviour, not a copy.
// Fixtures are isolated: committed data is only read (and cloned), never written.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { SiteData, SiteGroup } from '../src/derive/index.ts';
import { STAGE_LABEL } from '../src/derive/status.ts';
import { wi } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '..');
const site = JSON.parse(readFileSync(join(ROOT, 'data/derived/site.json'), 'utf8')) as SiteData;

// ---------------------------------------------------------------------------
// Fake DOM: just enough of the platform for app.ts, with real event bubbling and
// fragment navigation (scrolls only to rendered targets, hashchange only on change).
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (this: any, ev: any) => void;

class FakeEvent {
  type: string;
  key?: string;
  button = 0;
  bubbles = true;
  metaKey = false;
  ctrlKey = false;
  shiftKey = false;
  altKey = false;
  defaultPrevented = false;
  target: any = null;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class Listeners {
  listeners: Record<string, Listener[]> = {};
  addEventListener(t: string, f: Listener): void {
    (this.listeners[t] ??= []).push(f);
  }
}

function parseCompound(s: string): { tag: string | null; parts: { kind: string; v: string; value?: string }[] } {
  const m = /^([a-z][a-z0-9]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/i.exec(s);
  if (!m) throw new Error(`fake DOM: unsupported selector ${s}`);
  const parts = [...m[2].matchAll(/([#.])([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)].map((x) => (x[1] ? { kind: x[1], v: x[2] } : { kind: '[', v: x[3], value: x[4] }));
  return { tag: m[1] ? m[1].toUpperCase() : null, parts };
}

class El extends Listeners {
  tagName: string;
  doc: FakeDoc;
  parentNode: any = null;
  children: El[] = [];
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  hidden = false;
  open = false;
  value = '';
  textContent = '';
  className = '';
  id = '';
  href = '';
  target = '';
  rel = '';
  type = '';
  name = '';
  checked = false;
  isContentEditable = false;
  constructor(tag: string, doc: FakeDoc) {
    super();
    this.tagName = tag.toUpperCase();
    this.doc = doc;
  }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (xs: string[]) => { this.className = xs.join(' '); };
    return {
      add: (...k: string[]) => set([...new Set([...get(), ...k])]),
      remove: (...k: string[]) => set(get().filter((x) => !k.includes(x))),
      contains: (k: string) => get().includes(k),
      toggle: (k: string, on?: boolean) => { const has = get().includes(k); const want = on ?? !has; if (want && !has) set([...get(), k]); if (!want && has) set(get().filter((x) => x !== k)); return want; },
    };
  }
  append(...els: (El | string)[]): void {
    for (const e of els) {
      if (typeof e === 'string') { this.textContent += e; continue; }
      if (e.parentNode instanceof El) e.parentNode.children = e.parentNode.children.filter((c: El) => c !== e);
      e.parentNode = this;
      this.children.push(e);
    }
  }
  appendChild(e: El): El { this.append(e); return e; }
  replaceChildren(...els: El[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...els);
  }
  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      const k = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return k in this.dataset ? String(this.dataset[k]) : null;
    }
    if (name in this.attrs) return this.attrs[name];
    if (name === 'id' || name === 'type' || name === 'name' || name === 'href') return (this as any)[name] || null;
    return null;
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  matchesCompound(s: string): boolean {
    const c = parseCompound(s);
    if (c.tag && this.tagName !== c.tag) return false;
    for (const p of c.parts) {
      if (p.kind === '#' && this.id !== p.v) return false;
      if (p.kind === '.' && !this.classList.contains(p.v)) return false;
      if (p.kind === '[') { const a = this.getAttribute(p.v); if (a === null || (p.value !== undefined && a !== p.value)) return false; }
    }
    return true;
  }
  matches(sel: string): boolean {
    const chain = sel.trim().split(/\s+/);
    if (!this.matchesCompound(chain[chain.length - 1])) return false;
    let i = chain.length - 2;
    for (let n = this.parentNode; i >= 0 && n instanceof El; n = n.parentNode) if (n.matchesCompound(chain[i])) i--;
    return i < 0;
  }
  descendants(): El[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel: string): El[] { return this.descendants().filter((e) => e.matches(sel)); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): El | null {
    for (let n: any = this; n instanceof El; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  contains(other: any): boolean { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  dispatchEvent(ev: FakeEvent): boolean {
    ev.target ??= this;
    for (let n: any = this; n; n = n.parentNode) for (const f of n.listeners?.[ev.type] ?? []) f.call(n, ev);
    return !ev.defaultPrevented;
  }
  click(): void {
    const ev = new FakeEvent('click');
    this.dispatchEvent(ev);
    if (!ev.defaultPrevented && this.tagName === 'A') this.doc.navigate(this.href, this.target);
  }
  focus(): void {}
  select(): void {}
  scrollIntoView(): void { this.doc.scrolls.push(this.id || this.tagName); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  /** Rendered = neither it nor an ancestor is hidden. */
  get rendered(): boolean { for (let n: any = this; n instanceof El; n = n.parentNode) if (n.hidden) return false; return true; }
}
class FakeDetails extends El {}

class FakeWindow extends Listeners {
  [k: string]: any;
  fire(type: string): void { for (const f of this.listeners[type] ?? []) f.call(this, new FakeEvent(type)); }
}

class FakeLocation {
  href = '';
  origin = '';
  pathname = '';
  search = '';
  hash = '';
  constructor(href: string) { this.set(href); }
  set(href: string): void {
    const u = new URL(href);
    Object.assign(this, { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash });
  }
  replace(href: string): void { this.set(new URL(href, this.href).href); }
}

class FakeDoc extends Listeners {
  readyState = 'complete';
  documentElement: El;
  body: El;
  scrolls: string[] = [];
  fragmentScrolls: string[] = [];
  navigatedTo: string | null = null;
  win: FakeWindow;
  loc: FakeLocation;
  constructor(win: FakeWindow, loc: FakeLocation) {
    super();
    this.win = win;
    this.loc = loc;
    this.documentElement = new El('html', this);
    this.documentElement.parentNode = this;
    this.body = new El('body', this);
    this.documentElement.append(this.body);
  }
  createElement(tag: string): El { return tag === 'details' ? new FakeDetails(tag, this) : new El(tag, this); }
  querySelectorAll(sel: string): El[] { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel: string): El | null { return this.documentElement.querySelector(sel); }
  getElementById(id: string): El | null { return this.documentElement.descendants().find((e) => e.id === id) ?? null; }
  dispatchEvent(ev: FakeEvent): boolean { for (const f of this.listeners[ev.type] ?? []) f.call(this, ev); return !ev.defaultPrevented; }
  /** A link's default action: same-document fragment navigation or leaving the page. */
  navigate(href: string, target: string): void {
    if (target === '_blank') return;
    const next = new URL(href, this.loc.href);
    const cur = new URL(this.loc.href);
    if (next.origin !== cur.origin || next.pathname !== cur.pathname || next.search !== cur.search) { this.navigatedTo = next.href; return; }
    const changed = next.hash !== cur.hash;
    this.loc.set(next.href);
    let id = next.hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* as written */ }
    const el = id ? this.getElementById(id) : null;
    if (el?.rendered) this.fragmentScrolls.push(el.id); // a hidden target cannot be scrolled to
    if (changed) setImmediate(() => this.win.fire('hashchange'));
  }
}

const bundled = build({ entryPoints: [join(ROOT, 'src/site/client/app.ts')], bundle: true, format: 'iife', target: ['es2020'], write: false, logLevel: 'silent' }).then((r) => r.outputFiles[0].text);
const tick = () => new Promise((r) => setImmediate(r));

interface Booted { doc: FakeDoc; win: FakeWindow; loc: FakeLocation; dlg: El; q: El; list: El; errors: unknown[][]; error: unknown; fetches: () => number }

async function boot(opts: { url?: string; page?: string; fetcher?: (call: number) => Promise<any>; setup?: (doc: FakeDoc) => void } = {}): Promise<Booted> {
  const code = await bundled;
  const win = new FakeWindow();
  const loc = new FakeLocation(opts.url ?? 'https://example.test/tracker/releases/');
  const doc = new FakeDoc(win, loc);
  doc.body.dataset.base = '/tracker/';
  doc.body.dataset.page = opts.page ?? 'releases';
  const dlg = doc.createElement('dialog');
  dlg.id = 'search-dlg';
  const q = doc.createElement('input');
  q.id = 'sd-q';
  const list = doc.createElement('ul');
  list.id = 'sd-results';
  dlg.append(q, list);
  doc.body.append(dlg);
  opts.setup?.(doc);
  const errors: unknown[][] = [];
  let calls = 0;
  const fetcher = opts.fetcher ?? (async () => ({ ok: true, json: async () => [] }));
  const store = { getItem: () => null, setItem: () => {} };
  const ctx = {
    document: doc, window: win, location: loc, localStorage: store, sessionStorage: store, history: { replaceState: (_s: unknown, _t: string, u: URL | string) => loc.set(String(u)) },
    HTMLElement: El, Element: El, HTMLDetailsElement: FakeDetails, HTMLInputElement: El, HTMLAnchorElement: El, Node: El, Event: FakeEvent,
    URL, URLSearchParams, Date, setTimeout, fetch: () => fetcher(++calls),
    console: { error: (...a: unknown[]) => errors.push(a), warn: () => {}, log: () => {} },
  };
  let error: unknown = null;
  try {
    vm.runInNewContext(code, ctx);
  } catch (e) {
    error = e;
  }
  return { doc, win, loc, dlg, q, list, errors, error, fetches: () => calls };
}

const links = (b: Booted) => b.list.querySelectorAll('a');
const activeIndex = (b: Booted) => links(b).findIndex((l) => l.classList.contains('is-active'));
const key = (b: Booted, k: string) => b.q.dispatchEvent(new FakeEvent('keydown', { key: k }));
const ok = (entries: unknown) => async () => ({ ok: true, json: async () => entries });
const migrate = [0, 1, 2].map((i) => ({ k: 'Work', t: `migrate ${i}`, s: '', u: `/tracker/work/${i}/`, x: `migrate ${i}` }));

/** Releases page: the platform filter and three release blocks, as releases.ts renders them. */
function releasesDom(doc: FakeDoc): void {
  const seg = doc.createElement('div');
  for (const p of ['', 'desktop', 'android', 'ios']) {
    const b = doc.createElement('button');
    b.className = 'rfilter';
    b.dataset.platform = p;
    b.setAttribute('aria-pressed', String(p === ''));
    seg.append(b);
  }
  const ol = doc.createElement('ol');
  for (const [id, p] of [['desktop-1-97-56', 'desktop'], ['android-1-96-61', 'android'], ['ios-1-96-62', 'ios']]) {
    const li = doc.createElement('li');
    li.className = 'rel-v';
    li.id = id;
    li.dataset.platform = p;
    ol.append(li);
  }
  const empty = doc.createElement('p');
  empty.id = 'rel-empty';
  empty.hidden = true;
  doc.body.append(seg, ol, empty);
}
const relEntries = [
  { k: 'Release note', t: 'Ironwood on Android', s: 'Android 1.96.61', u: '/tracker/releases/#android-1-96-61', x: 'ironwood on android android 1.96.61' },
  { k: 'Release note', t: 'Ironwood on Desktop', s: 'Desktop 1.97.56', u: '/tracker/releases/#desktop-1-97-56', x: 'ironwood on desktop desktop 1.97.56' },
];
const filterBtn = (doc: FakeDoc, p: string) => doc.querySelectorAll('.rfilter').find((b) => b.dataset.platform === p)!;
const pressed = (doc: FakeDoc) => doc.querySelectorAll('.rfilter').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.platform);

// ---------------------------------------------------------------------------
// UI-C1: malformed fragments and isolated initialization
// ---------------------------------------------------------------------------

test('UI-C1: a malformed fragment (#%ZZ) does not stop filters, search or keyboard setup', async () => {
  const b = await boot({
    url: 'https://example.test/tracker/work/?q=58957#%ZZ',
    page: 'work',
    setup: (doc) => {
      const form = doc.createElement('form');
      form.id = 'work-filters';
      const wq = doc.createElement('input');
      wq.id = 'wq';
      form.append(wq);
      const ol = doc.createElement('ol');
      ol.id = 'work-list';
      for (const [n, text] of [['1', 'zcash sync #58957 58957'], ['2', 'ironwood memos #57000 57000']]) {
        const li = doc.createElement('li');
        li.className = 'wrow';
        li.id = `row-${n}`;
        Object.assign(li.dataset, { text, updated: `2026-10-0${n}`, number: n });
        ol.append(li);
      }
      const count = doc.createElement('p');
      count.id = 'work-count';
      const empty = doc.createElement('p');
      empty.id = 'work-empty';
      doc.body.append(form, ol, count, empty);
    },
  });
  assert.equal(b.error, null);
  assert.equal(typeof b.win.zbtOpenSearch, 'function', 'global search initialized');
  assert.equal(b.doc.getElementById('wq')!.value, '58957', 'filter restored from the URL');
  assert.equal(b.doc.getElementById('row-1')!.hidden, false);
  assert.equal(b.doc.getElementById('row-2')!.hidden, true, 'filtering applied');
  assert.equal(b.doc.getElementById('work-count')!.textContent, '1 of 2 groups');
  assert.ok(b.doc.listeners.keydown?.length, 'keyboard shortcuts registered');
  // A later malformed fragment change is harmless too.
  b.loc.set('https://example.test/tracker/work/?q=58957#%E0%A4%A');
  assert.doesNotThrow(() => b.win.fire('hashchange'));
});

test('UI-C1: one failing setup step is reported and the remaining steps still run', async () => {
  const b = await boot({
    setup: (doc) => {
      const fresh = doc.createElement('a');
      fresh.className = 'fresh';
      fresh.dataset = new Proxy({}, { get: () => { throw new Error('unexpected markup'); } });
      doc.body.append(fresh);
      releasesDom(doc);
    },
  });
  assert.equal(b.error, null);
  assert.ok(b.errors.some((e) => /freshness/.test(String(e[0]))), 'the failure is logged with its step');
  assert.equal(typeof b.win.zbtOpenSearch, 'function', 'search still initialized after the failing step');
  filterBtn(b.doc, 'desktop').click();
  assert.equal(b.doc.getElementById('android-1-96-61')!.hidden, true, 'release filter still initialized');
});

test('UI-C1: hashId and runIsolated never throw on bad input', async () => {
  const { hashId, runIsolated } = await import('../src/site/client/logic.ts');
  assert.equal(hashId('#%ZZ'), '%ZZ');
  assert.equal(hashId('#%E0%A4%A'), '%E0%A4%A');
  assert.equal(hashId('#android-1-96-61'), 'android-1-96-61');
  assert.equal(hashId('#caf%C3%A9'), 'café');
  assert.equal(hashId(''), null);
  assert.equal(hashId('#'), null);
  const ran: string[] = [];
  const seen: string[] = [];
  const failed = runIsolated([['a', () => ran.push('a')], ['b', () => { throw new URIError('URI malformed'); }], ['c', () => ran.push('c')]], (name) => { seen.push(name); throw new Error('reporter broke'); });
  assert.deepEqual(ran, ['a', 'c']);
  assert.deepEqual(failed, ['b']);
  assert.deepEqual(seen, ['b']);
});

// ---------------------------------------------------------------------------
// UI-C2: keyboard selection
// ---------------------------------------------------------------------------

test('UI-C2: the first ArrowUp selects the last result, ArrowDown the first, and both wrap', async () => {
  const b = await boot({ fetcher: ok(migrate) });
  b.q.value = 'migrate';
  b.win.zbtOpenSearch();
  await tick();
  assert.equal(links(b).length, 3);
  key(b, 'ArrowUp');
  assert.equal(activeIndex(b), 2);
  key(b, 'ArrowDown');
  assert.equal(activeIndex(b), 0, 'wraps from last to first');
  key(b, 'ArrowUp');
  assert.equal(activeIndex(b), 2, 'wraps from first to last');
  b.q.dispatchEvent(new FakeEvent('input'));
  key(b, 'ArrowDown');
  assert.equal(activeIndex(b), 0, 'after new input, ArrowDown starts at the first result');

  const { nextIndex } = await import('../src/site/client/logic.ts');
  assert.equal(nextIndex(-1, -1, 3), 2);
  assert.equal(nextIndex(-1, 1, 3), 0);
  assert.equal(nextIndex(2, 1, 3), 0);
  assert.equal(nextIndex(0, -1, 3), 2);
  assert.equal(nextIndex(1, 1, 3), 2);
  assert.equal(nextIndex(-1, -1, 1), 0);
  assert.equal(nextIndex(-1, 1, 0), -1);
  assert.equal(nextIndex(5, -1, 3), 2, 'a stale selection restarts');
});

// ---------------------------------------------------------------------------
// UI-C3: search index failure is not cached
// ---------------------------------------------------------------------------

test('UI-C3: a failed index request shows an unavailable state and reopening search retries', async () => {
  const b = await boot({ fetcher: async (n) => (n === 1 ? { ok: false, status: 503, json: async () => [] } : { ok: true, json: async () => migrate }) });
  b.q.value = 'migrate';
  b.win.zbtOpenSearch();
  await tick();
  const err = b.list.querySelector('.sd-error');
  assert.ok(err, 'unavailable state shown');
  assert.match(err!.textContent, /unavailable/i);
  assert.doesNotMatch(b.list.descendants().map((e) => e.textContent).join(' '), /Nothing matches/);
  assert.equal(links(b).length, 0);
  b.dlg.close();
  b.win.zbtOpenSearch();
  await tick();
  assert.equal(b.fetches(), 2, 'the failure was not cached');
  assert.equal(links(b).length, 3);
  b.dlg.close();
  b.win.zbtOpenSearch();
  await tick();
  assert.equal(b.fetches(), 2, 'a successful index is cached');
});

test('UI-C3: the retry button and Enter recover without a reload; bad JSON counts as a failure', async () => {
  const b = await boot({ fetcher: async (n) => (n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : n === 2 ? { ok: true, json: async () => { throw new SyntaxError('bad json'); } } : { ok: true, json: async () => migrate }) });
  b.q.value = 'migrate';
  b.win.zbtOpenSearch();
  await tick();
  const retry = b.list.querySelector('button.sd-retry');
  assert.ok(retry, 'retry control shown');
  assert.match(retry!.textContent, /try again/i);
  retry!.click();
  await tick();
  assert.equal(b.fetches(), 2);
  assert.ok(b.list.querySelector('.sd-error'), 'unparsable index is still unavailable, not "no results"');
  key(b, 'Enter');
  await tick();
  assert.equal(b.fetches(), 3);
  assert.equal(links(b).length, 3);
});

test('UI-C3: the index loader shares one request, caches only success and survives a synchronous throw', async () => {
  const { createIndexLoader } = await import('../src/site/client/logic.ts');
  let calls = 0;
  let fail = true;
  const loader = createIndexLoader<number>(async () => { calls++; if (fail) throw new Error('offline'); return [1, 2]; });
  assert.equal(loader.state, 'idle');
  const [a, c] = [loader.load(), loader.load()];
  assert.equal(loader.state, 'loading');
  assert.deepEqual(await Promise.all([a, c]), ['failed', 'failed']);
  assert.equal(calls, 1, 'concurrent loads share one request');
  assert.equal(loader.entries, null);
  fail = false;
  assert.equal(await loader.load(), 'ready');
  assert.deepEqual(loader.entries, [1, 2]);
  await loader.load();
  assert.equal(calls, 2);

  const notList = createIndexLoader(async () => ({ error: 'nope' }));
  assert.equal(await notList.load(), 'failed');
  let syncCalls = 0;
  const sync = createIndexLoader((() => { syncCalls++; throw new Error('sync'); }) as () => Promise<unknown>);
  assert.equal(await sync.load(), 'failed');
  assert.equal(await sync.load(), 'failed');
  assert.equal(syncCalls, 2, 'a synchronous failure is retried too');
});

// ---------------------------------------------------------------------------
// UI-C7 / UI-C8: same-page results close the dialog and reveal the target
// ---------------------------------------------------------------------------

test('UI-C7: choosing a same-page release result closes the dialog and scrolls to the release', async () => {
  const b = await boot({ fetcher: ok(relEntries), setup: releasesDom });
  b.q.value = '1.97.56';
  b.win.zbtOpenSearch();
  await tick();
  assert.equal(b.dlg.open, true);
  assert.equal(links(b).length, 1);
  key(b, 'Enter');
  assert.equal(b.dlg.open, false, 'dialog closed after Enter');
  assert.equal(b.loc.hash, '#desktop-1-97-56');
  assert.deepEqual(b.doc.fragmentScrolls, ['desktop-1-97-56']);

  // Clicking a result behaves the same way.
  b.q.value = 'android';
  b.win.zbtOpenSearch();
  await tick();
  links(b)[0].click();
  assert.equal(b.dlg.open, false, 'dialog closed after click');
  assert.equal(b.loc.hash, '#android-1-96-61');
});

test('UI-C8: a release hidden by an incompatible platform filter is revealed and the filter stays consistent', async () => {
  const b = await boot({ fetcher: ok(relEntries), setup: releasesDom });
  filterBtn(b.doc, 'desktop').click();
  const android = b.doc.getElementById('android-1-96-61')!;
  assert.equal(android.hidden, true);
  b.q.value = 'android ironwood';
  b.win.zbtOpenSearch();
  await tick();
  key(b, 'Enter');
  assert.equal(b.dlg.open, false);
  assert.equal(android.hidden, false, 'target revealed');
  assert.deepEqual(pressed(b.doc), ['android'], 'filter buttons match what is shown');
  assert.equal(b.doc.getElementById('desktop-1-97-56')!.hidden, true);
  assert.equal(b.doc.getElementById('rel-empty')!.hidden, true);
  assert.deepEqual(b.doc.fragmentScrolls, ['android-1-96-61'], 'revealed before the fragment navigation scrolled');
  await tick();

  // Choosing the fragment the page is already on fires no hashchange; it must still be revealed.
  filterBtn(b.doc, 'ios').click();
  assert.equal(android.hidden, true);
  b.win.zbtOpenSearch();
  await tick();
  key(b, 'Enter');
  assert.equal(android.hidden, false);
  assert.deepEqual(pressed(b.doc), ['android']);
  assert.equal(b.dlg.open, false);
});

test('UI-C8: a fragment change (back/forward, typed URL) also reveals a filtered-out release', async () => {
  const b = await boot({ setup: releasesDom });
  filterBtn(b.doc, 'ios').click();
  b.loc.set('https://example.test/tracker/releases/#desktop-1-97-56');
  b.win.fire('hashchange');
  assert.equal(b.doc.getElementById('desktop-1-97-56')!.hidden, false);
  assert.deepEqual(pressed(b.doc), ['desktop']);
  assert.ok(b.doc.scrolls.includes('desktop-1-97-56'), 'scrolled once it became visible');
  // With "All" selected nothing changes.
  filterBtn(b.doc, '').click();
  const before = b.doc.scrolls.length;
  b.loc.set('https://example.test/tracker/releases/#ios-1-96-62');
  b.win.fire('hashchange');
  assert.deepEqual(pressed(b.doc), ['']);
  assert.equal(b.doc.scrolls.length, before);
});

test('UI-C7/C8: same-page detection and filter reconciliation helpers', async () => {
  const { samePageFragment, filterForTarget, rankSearch, safeHref } = await import('../src/site/client/logic.ts');
  const here = 'https://example.test/tracker/releases/#desktop-1-97-56';
  assert.equal(samePageFragment('/tracker/releases/#android-1-96-61', here), 'android-1-96-61');
  assert.equal(samePageFragment('/tracker/releases/#desktop-1-97-56', here), 'desktop-1-97-56');
  assert.equal(samePageFragment('/tracker/releases/', here), null);
  assert.equal(samePageFragment('/tracker/work/x/#m', here), null);
  assert.equal(samePageFragment('/tracker/releases/?a=1#x', here), null, 'another query loads a new document');
  assert.equal(samePageFragment('https://community.brave.app/tracker/releases/#x', here), null);
  assert.equal(samePageFragment('/tracker/releases/#%ZZ', here), '%ZZ');
  assert.equal(filterForTarget('desktop', 'android'), 'android');
  assert.equal(filterForTarget('android', 'android'), 'android');
  assert.equal(filterForTarget('', 'android'), '');
  assert.equal(filterForTarget('desktop', null), 'desktop');
  // Ranking and target safety kept their previous behaviour after moving out of app.ts.
  const idx = [
    { k: 'Release note', t: 'Ironwood', s: '', u: '/r/', x: 'ironwood' },
    { k: 'Feature', t: 'Other', s: '', u: '/f/', x: 'other ironwood' },
    { k: 'Feature', t: 'Ironwood pool', s: '', u: '/f2/', x: 'ironwood pool' },
  ];
  assert.deepEqual(rankSearch(idx, 'Ironwood').map((e) => e.u), ['/f2/', '/f/', '/r/']);
  assert.deepEqual(rankSearch(idx, '  '), []);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('//evil.example/x'), null);
  assert.equal(safeHref('https://community.brave.app/t/1'), 'https://community.brave.app/t/1');
});

// ---------------------------------------------------------------------------
// UI-C4: server-side switch and NU7 wording keep unknown as unknown
// ---------------------------------------------------------------------------

function withGate3(disabled: boolean | null): SiteData {
  const d = structuredClone(site);
  const sv = d.upstream.services ?? { gate3: null, studies: [], studiesCommit: null };
  d.upstream.services = { ...sv, gate3: { commitSha: '173a2408a66739d5c5204e3bac386fa9d2c2a17c', file: 'app/api/swap/constants.py', zcashDisabled: disabled, line: disabled === null ? null : 18, url: 'https://github.com/brave/gate3/blob/173a2408a66739d5c5204e3bac386fa9d2c2a17c/app/api/swap/constants.py', checkedAt: '2026-10-08T18:31:50.651Z' } };
  return d;
}
const gate3Item = (html: string) => {
  const m = html.match(/<li><svg class="g g-([\w-]+)"[^>]*><use[^>]*\/><\/svg><div><strong>(ZEC swaps[^<]*)<\/strong><p>([\s\S]*?)<\/p><\/div><\/li>/);
  assert.ok(m, 'gate3 readiness item rendered');
  return { glyph: m![1], headline: m![2], body: m![3] };
};

test('UI-C4: home shows distinct true / false / unknown gate3 wording and glyphs, about the public repository', async () => {
  const { homePage } = await import('../src/site/pages/home.ts');
  const [on, off, unknown] = [true, false, null].map((v) => gate3Item(homePage(withGate3(v), [], []).value));
  assert.deepEqual(new Set([on.glyph, off.glyph, unknown.glyph]).size, 3, 'three distinct glyphs');
  assert.equal(unknown.glyph, 'not-verified');
  assert.equal(new Set([on.headline, off.headline, unknown.headline]).size, 3);
  assert.match(unknown.headline, /unknown/i);
  assert.doesNotMatch(unknown.headline, /not (disabled|switched off)/i);
  assert.match(unknown.body, /whether it includes <code>Chain\.ZCASH<\/code> is unknown/);
  assert.doesNotMatch(unknown.body, /does not include|lists Zcash/);
  assert.match(off.body, /does not include <code>Chain\.ZCASH<\/code>/);
  assert.doesNotMatch(off.body, /lists Zcash|SWAP_DISABLED_CHAINS<\/code> includes/, 'false never claims Zcash is listed');
  assert.match(on.body, /<code>SWAP_DISABLED_CHAINS<\/code> includes <code>Chain\.ZCASH<\/code>/);
  for (const x of [on, off, unknown]) {
    assert.match(x.body, /public swap backend repository/);
    assert.match(x.body, /deployed service could differ/);
    assert.doesNotMatch(x.headline, /server-side$/, 'no claim about the deployed runtime state');
  }
});

test('UI-C4: Upstream and server-side work pages never turn an unknown gate3 switch into "does not include"', async () => {
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const { detailPage } = await import('../src/site/pages/work.ts');
  const up = upstreamPage(withGate3(null)).value;
  const g3 = up.slice(up.indexOf('id="g3-h"'), up.indexOf('</section>', up.indexOf('id="g3-h"')));
  assert.match(g3, /Unknown/);
  assert.match(g3, /whether it includes <code>Chain\.ZCASH<\/code> is unknown/);
  assert.doesNotMatch(g3, /does not include|not disabled/);
  assert.match(upstreamPage(withGate3(false)).value, /does not include <code>Chain\.ZCASH<\/code>/);

  // A PR-led group whose only change is in brave/gate3 (server-side).
  const id = 'brave/gate3#9001';
  const pr = wi(id, { kind: 'pr', state: 'merged', mergedAt: '2026-09-01T00:00:00Z', baseRef: 'master', isDraft: false, url: 'https://github.com/brave/gate3/pull/9001' });
  const withPr = (d: SiteData) => {
    (d.items as Record<string, unknown>)[id] = pr;
    return d;
  };
  const base = structuredClone(site.groups[0]);
  const g = { ...base, id, lead: id, members: { issues: [], masterPrs: [id], uplifts: [], duplicates: [], mentions: [], children: [], epic: null }, status: { ...base.status, issueState: null, duplicate: null, builds: [], releaseNotes: [] } } as SiteGroup;
  const unknownHtml = detailPage(g, withPr(withGate3(null)), { [id]: pr }, [], []).value;
  assert.match(unknownHtml, /Current state of the public repository: <code>SWAP_DISABLED_CHAINS<\/code> was not found in the checked file, so whether it includes <code>Chain\.ZCASH<\/code> is unknown/);
  assert.doesNotMatch(unknownHtml, /does not include <code>Chain\.ZCASH/);
  assert.match(detailPage(g, withPr(withGate3(false)), { [id]: pr }, [], []).value, /does not include <code>Chain\.ZCASH<\/code>/);
});

test('UI-C4: unknown NU7 readiness and status read as unknown, with a glyph distinct from a known gap', async () => {
  const { homePage } = await import('../src/site/pages/home.ts');
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const { nu7Facts } = await import('../src/site/view.ts');
  const nu7 = (braveHasBranchId: boolean | null) => {
    const d = structuredClone(site);
    d.upstream.nextUpgrade = { name: 'NU7', zip: '0259', zipStatus: null, testnetHeight: null, mainnetHeight: null, branchId: '0x77190AD9', braveForkSha: null, braveHasBranchId, braveGatedUnstable: null, braveUrl: null, upstreamHasBranchId: null, upstreamUrl: 'https://github.com/zcash/librustzcash', checkedAt: '2026-10-08T00:00:00Z' };
    return d;
  };
  const item = (d: SiteData) => homePage(d, [], []).value.match(/<li><svg class="g g-([\w-]+)"[^>]*><use[^>]*\/><\/svg><div><strong>(NU7 network upgrade:[^<]*)<\/strong><p>([\s\S]*?)<\/p>/)!;
  const unknown = item(nu7(null));
  const lacks = item(nu7(false));
  assert.equal(unknown[1], 'not-verified');
  assert.equal(lacks[1], 'warn');
  assert.match(unknown[2], /unknown/);
  assert.match(unknown[3], /of unknown status; mainnet height: unknown\. Upstream librustzcash is unknown/);
  const up = upstreamPage(nu7(null)).value;
  const facet = up.slice(up.indexOf('id="nu7-h"'), up.indexOf('</section>', up.indexOf('id="nu7-h"')));
  assert.match(facet, /status unknown/);
  assert.match(facet, /Testnet activation: <span class="mono">unknown<\/span>/);
  assert.match(facet, /unknown whether its pinned librustzcash fork defines/);
  assert.match(facet, /unknown whether it defines it/);
  assert.equal(nu7Facts({ name: 'NU7', braveHasBranchId: true, upstreamHasBranchId: true }).glyph, 'available');
});

// ---------------------------------------------------------------------------
// UI-C5: unknown fix build presence is not worded as absence
// ---------------------------------------------------------------------------

function group(builds: { platform: string; channel: string; included: boolean | null }[], fix = 'merged'): SiteGroup {
  const base = structuredClone(site.groups[0]);
  return { ...base, status: { ...base.status, implementation: { state: fix, mergedAt: null, prs: [] }, builds: builds.map((b) => ({ ...b, version: '1.0.0', via: null, basis: '' })) } } as unknown as SiteGroup;
}

test('UI-C5: only explicit "not included" checks support absence of a merged fix', async () => {
  const { fixFacts } = await import('../src/site/view.ts');
  const all = (included: boolean | null) => ['desktop', 'android', 'ios'].flatMap((platform) => ['release', 'beta', 'nightly'].map((channel) => ({ platform, channel, included })));
  for (const builds of [[], all(null)]) {
    const f = fixFacts(group(builds));
    assert.doesNotMatch(f.summary, /not yet in a checked build/i);
    assert.match(f.summary, /unknown/);
    assert.equal(f.inBuild, 'unknown');
  }
  const absent = fixFacts(group(all(false)));
  assert.equal(absent.summary, 'A linked fix is merged but not yet in a checked build');
  assert.equal(absent.inBuild, 'no');
  const mixed = fixFacts(group([...all(false).slice(0, 2), ...all(null).slice(2)]));
  assert.equal(mixed.summary, 'A linked fix is merged; it is not in 2 checked builds, and whether it is in the other 7 is unknown');
  assert.equal(mixed.inBuild, 'unknown');
  const yes = fixFacts(group([{ platform: 'desktop', channel: 'release', included: true }, { platform: 'ios', channel: 'release', included: null }]));
  assert.equal(yes.summary, 'A linked fix is in Release: Desktop 1.0.0');
  assert.equal(yes.inBuild, 'yes');
  assert.equal(fixFacts(group([], 'open')).inBuild, null);
});

// ---------------------------------------------------------------------------
// UI-C6: "Ahead in pre-release builds" footnote matches the Release statuses shown
// ---------------------------------------------------------------------------

function capRow(id: string, name: string, release: string, ahead: string) {
  const cells = ['desktop', 'android', 'ios'].flatMap((platform) => ['release', 'beta', 'nightly'].map((channel) => ({
    platform, channel, version: '1.0.0', since: null, summary: '', evidence: [],
    status: platform === 'desktop' ? 'available' : channel === 'release' ? release : ahead,
  })));
  return { id, name, description: '', notes: [], cells };
}

test('UI-C6: the footnote says flagged Release code is present but off, and never "not yet in a Release build"', async () => {
  const { homePage } = await import('../src/site/pages/home.ts');
  const d = structuredClone(site);
  d.capabilities = [capRow('ironwood', 'Ironwood pool (NU6.3)', 'opt-in', 'in-build'), capRow('memos', 'Memos', 'opt-in', 'in-build')] as unknown as SiteData['capabilities'];
  const out = homePage(d, [], []).value;
  for (const p of ['android', 'ios']) {
    const block = out.match(new RegExp(`<div class="coming" data-p="${p}"[\\s\\S]*?</div>`))![0];
    assert.match(block, /Behind a flag/);
    assert.doesNotMatch(block, /not yet in a Release build/);
    assert.match(block, /“Behind a flag” in Release means the code is already in the Release build but switched off by default/);
    assert.match(block, /switched on by default in the Beta or Nightly build shown\. That is not a release announcement/);
  }
  const { comingNextNote } = await import('../src/site/view.ts');
  const note = comingNextNote([{ release: { status: 'absent' }, ahead: { status: 'in-build' } }, { release: { status: 'in-build' }, ahead: { status: 'available' } }, { release: { status: 'not-verified' }, ahead: { status: 'in-build' } }]);
  assert.match(note, /“Not in this build” means the Release build does not contain it/);
  assert.match(note, /“In build, not announced” means the code is on by default in Release, but no release note announces it/);
  assert.match(note, /“Not verified” means its presence in the Release build is unknown/);
  assert.doesNotMatch(note, /already in the Release build/);
});

// ---------------------------------------------------------------------------
// EXTRA-5: preview server (run as the real script, as `npm run serve` does)
// ---------------------------------------------------------------------------

let server: ChildProcess | null = null;
let port = 0;
let fixtureRoot = '';
let serverLog = '';

function get(path: string): Promise<{ status?: number; location?: string | null; body?: string; error?: string }> {
  return new Promise((done) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => done({ status: res.statusCode, location: res.headers.location ?? null, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', (e: NodeJS.ErrnoException) => done({ error: e.code ?? e.message }));
  });
}

before(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'zbt-serve-'));
  const out = join(fixtureRoot, 'preview');
  mkdirSync(join(out, 'work'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'preview-private'));
  writeFileSync(join(out, 'index.html'), 'HOME_FIXTURE');
  writeFileSync(join(out, 'work/index.html'), 'WORK_FIXTURE');
  writeFileSync(join(out, '404.html'), 'NOT_FOUND_FIXTURE');
  writeFileSync(join(fixtureRoot, 'preview-private/marker.txt'), 'OUTSIDE_ROOT_MARKER');
  port = await new Promise<number>((done) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => done(p)); }); });
  server = spawn(process.execPath, [join(ROOT, 'scripts/serve.ts'), String(port)], { env: { ...process.env, TRACKER_OUT_DIR: out, TRACKER_BASE_PATH: '/base/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr!.on('data', (c) => { serverLog += String(c); });
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => fail(new Error(`preview server did not start: ${serverLog}`)), 10000);
    server!.stdout!.once('data', () => { clearTimeout(t); done(); });
    server!.once('exit', (code) => { clearTimeout(t); fail(new Error(`preview server exited ${code}: ${serverLog}`)); });
  });
});

after(() => {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

test('EXTRA-5: malformed request paths get 400 and the preview server keeps serving', async () => {
  for (const path of ['/base/%ZZ', '/base/%E0%A4%A', '/base/work/%', '/base/%00']) {
    const r = await get(path);
    assert.equal(r.status, 400, `${path}: ${JSON.stringify(r)} ${serverLog}`);
  }
  const home = await get('/base/');
  assert.equal(home.status, 200);
  assert.equal(home.body, 'HOME_FIXTURE');
  assert.equal(server!.exitCode, null, 'still running');
});

test('EXTRA-5: preview server stays inside its directory and mirrors GitHub Pages paths', async () => {
  const sibling = await get('/base/%2e%2e%2fpreview-private/marker.txt');
  assert.equal(sibling.status, 403, 'a sibling directory sharing the name prefix is outside the root');
  assert.doesNotMatch(sibling.body ?? '', /OUTSIDE_ROOT_MARKER/);
  assert.equal((await get('/base/..%2f..%2fetc/passwd')).status, 403);
  const slashless = await get('/base/work');
  assert.equal(slashless.status, 301);
  assert.equal(slashless.location, '/base/work/');
  assert.equal((await get('/base/work/')).body, 'WORK_FIXTURE');
  const missing = await get('/base/missing/');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, 'NOT_FOUND_FIXTURE');
  const root = await get('/');
  assert.equal(root.status, 302);
  assert.equal(root.location, '/base/');
  assert.equal((await get('/elsewhere/')).status, 404);
  assert.equal(server!.exitCode, null);
});

test('UI-C4: "Off server-side" cells describe Brave’s public server-side code, not the deployed service', async () => {
  const { statusExplain, comingNextNote } = await import('../src/site/view.ts');
  const { featuresPage } = await import('../src/site/pages/features.ts');
  const cell = { platform: 'android' as const, channel: 'release' as const, version: '1.96.61', status: 'service-off', since: null, summary: 'currently turned off server-side for Zcash, for every client.' };
  for (const text of [statusExplain(cell, true), statusExplain(cell), comingNextNote([{ release: { status: 'service-off' }, ahead: { status: 'in-build' } }])]) {
    assert.match(text, /public server-side code/);
    assert.doesNotMatch(text, /server(-side)? setting turns/);
  }
  assert.match(statusExplain(cell), /deployed service could differ/);
  const legend = featuresPage(site).value.match(/<li><span class="badge s-service-off"[\s\S]*?<\/li>/)![0];
  assert.match(legend, /public server-side code switches it off for everyone; the deployed service could differ/);
});

// ---------------------------------------------------------------------------
// Repair round (UI-C4, UI-C5): the verifier read the rendered pages, so these tests render them too.
// Capability cells come from derive's real buildCapabilities() and serviceChecks() over the committed
// source envelopes; only the gate3 switch is varied.
// ---------------------------------------------------------------------------

const sourceData = (id: string) => JSON.parse(readFileSync(join(ROOT, 'data/sources', `${id}.json`), 'utf8')).data;
const USABLE_STATUSES = ['available', 'in-build', 'opt-in'];
type Services = SiteData['upstream']['services'];

async function deriveCapabilities(services: Services): Promise<SiteData['capabilities']> {
  const { buildCapabilities } = await import('../src/derive/capabilities.ts');
  const { serviceChecks } = await import('../src/derive/index.ts');
  const { CAPABILITIES } = await import('../config/capabilities.ts');
  const flags = sourceData('brave-flags');
  const items = sourceData('github-items').items;
  const groupOf = new Map<string, SiteGroup>();
  for (const g of site.groups) for (const id of [g.lead, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates]) if (!groupOf.has(id)) groupOf.set(id, g);
  return buildCapabilities({
    defs: CAPABILITIES,
    current: site.channels,
    changelog: sourceData('brave-changelogs').entries,
    flagsByTag: flags.snapshots,
    sourceChecks: flags.checks,
    items,
    groupStatus: (id) => groupOf.get(id)?.status ?? null,
    docs: sourceData('docs').pages,
    serviceChecks: serviceChecks(services, items),
  });
}

async function siteWithSwitch(disabled: boolean | null | 'no-data'): Promise<SiteData> {
  const d = structuredClone(site);
  d.upstream.services = disabled === 'no-data' ? null : withGate3(disabled).upstream.services;
  d.capabilities = await deriveCapabilities(d.upstream.services);
  return d;
}

const bridgeCard = (homeHtml: string) => {
  const m = homeHtml.match(/<article class="fcard">(?:(?!<\/article>)[\s\S])*?features\/bridge\/[\s\S]*?<\/article>/);
  assert.ok(m, 'bridge card rendered');
  return m![0];
};
const bridgeMatrixRow = (featuresHtml: string) => {
  const start = featuresHtml.search(/<div class="fx-row" role="row">\s*<div class="fx-name" role="rowheader"><a href="[^"]*features\/bridge\/">/);
  assert.ok(start >= 0, 'bridge matrix row rendered');
  const next = featuresHtml.indexOf('<div class="fx-row"', start + 10);
  return featuresHtml.slice(start, next > 0 ? next : featuresHtml.indexOf('<p class="fine">', start));
};
const usableBadge = /class="badge s-(available|in-build|opt-in)"/;

test('UI-C4 (repair): derive cells for the real data match the committed Bridge row (fixture sanity)', async () => {
  const caps = await deriveCapabilities(site.upstream.services);
  const mine = caps.find((r) => r.id === 'bridge')!.cells.map((c) => `${c.platform}/${c.channel}=${c.status}`);
  const committed = site.capabilities.find((r) => r.id === 'bridge')!.cells.map((c) => `${c.platform}/${c.channel}=${c.status}`);
  assert.deepEqual(mine, committed);
});

test('UI-C4 (repair): an unknown or unread gate3 switch never shows Bridge as usable on any page', async () => {
  const { presentCapabilities, statusExplain } = await import('../src/site/view.ts');
  const { homePage } = await import('../src/site/pages/home.ts');
  const { featuresPage, featurePage } = await import('../src/site/pages/features.ts');
  for (const state of [null, 'no-data'] as const) {
    const d = await siteWithSwitch(state);
    const raw = d.capabilities.find((r) => r.id === 'bridge')!;
    // Rendered pages first: home card, matrix row and the feature page (given the derived row, as build.ts does).
    const home = homePage(d, [], []).value;
    const card = bridgeCard(home);
    assert.doesNotMatch(card, usableBadge, `${state}: home card`);
    assert.match(card, /Not verified/);
    assert.match(card, /whether the server-side switch turns it off is unknown/);
    assert.doesNotMatch(bridgeMatrixRow(featuresPage(d).value), usableBadge, `${state}: features matrix`);
    const page = featurePage(raw, d).value;
    assert.doesNotMatch(page, usableBadge, `${state}: feature page`);
    assert.match(page, /could not be read from the public code/);
    // Per-build counts on the home page agree with the cards they summarise.
    for (const k of ['desktop/release', 'android/beta', 'ios/nightly']) {
      const head = home.match(new RegExp(`<div class="build-head" data-k="${k}"[\\s\\S]*?</ul>`))![0];
      const counted = Object.fromEntries([...head.matchAll(/class="badge s-([\w-]+)"[^>]*>[\s\S]*?<span>(\d+) /g)].map((m) => [m[1], Number(m[2])]));
      const cards: Record<string, number> = {};
      for (const m of home.matchAll(new RegExp(`<span class="fcard-b" data-k="${k}"[^>]*><span class="badge s-([\\w-]+)"`, 'g'))) cards[m[1]] = (cards[m[1]] ?? 0) + 1;
      assert.deepEqual(counted, cards, `${state}: ${k} counts match the cards`);
    }
    // The presented cells behind them.
    const shown = presentCapabilities(d).find((r) => r.id === 'bridge')!;
    let lowered = 0;
    shown.cells.forEach((cell, i) => {
      const before = raw.cells[i];
      assert.ok(!USABLE_STATUSES.includes(cell.status), `${state}: ${cell.platform}/${cell.channel} is ${cell.status}`);
      if (USABLE_STATUSES.includes(before.status)) {
        lowered++;
        assert.equal(cell.status, 'not-verified');
        assert.equal(cell.appStatus, before.status, 'the app-side status is kept');
        assert.match(cell.summary, /whether Brave’s server-side switch turns it off for Zcash is unknown/);
        assert.ok(cell.evidence.some((e) => e.kind === 'note' && e.text.includes('App-side status:')));
        assert.ok(cell.evidence.some((e) => e.kind === 'service'), 'the unread switch is listed as evidence');
        assert.doesNotMatch(statusExplain(cell), /No evidence either way/);
        assert.match(statusExplain(cell, true), /server-side switch turns it off is unknown/);
      } else assert.equal(cell.status, before.status, 'non-usable statuses are unchanged');
    });
    assert.ok(lowered > 0, `${state}: derivation left usable Bridge cells, which the site must not show as usable`);
  }
});

test('UI-C4 (repair): a known switch keeps derived statuses, and "Off server-side" text describes the public code', async () => {
  const { presentCapabilities } = await import('../src/site/view.ts');
  const { featuresPage, featurePage } = await import('../src/site/pages/features.ts');
  const { homePage } = await import('../src/site/pages/home.ts');
  const { sourcesPage } = await import('../src/site/pages/other.ts');
  const on = await siteWithSwitch(true);
  const bridge = on.capabilities.find((r) => r.id === 'bridge')!;
  assert.ok(bridge.cells.every((c) => c.status === 'service-off'));
  const runtime = /currently turned off|turned off server-side|has this turned off/;
  const matrix = featuresPage(on).value;
  const page = featurePage(bridge, on).value;
  const sources = sourcesPage(on, [], {}).value;
  for (const [name, out] of [['features', matrix], ['feature page', page], ['home', homePage(on, [], []).value], ['sources', sources]] as const) assert.doesNotMatch(out, runtime, name);
  const tips = [...bridgeMatrixRow(matrix).matchAll(/class="fx-line" title="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(tips.length, 9);
  for (const t of tips) assert.match(t, /Brave’s public server-side code switches it off for Zcash, for every client\. The deployed service could differ\./);
  const sums = [...page.matchAll(/<p class="ev-sum">([^<]*)<\/p>/g)].map((m) => m[1]);
  assert.equal(sums.length, 9);
  assert.ok(sums.some((s) => /^Shipped in Desktop [\d.]+, but Brave’s public server-side code switches it off for Zcash/.test(s)));
  assert.ok(sums.every((s) => /public server-side code/.test(s)));
  const legend = sources.match(/<dt>Off server-side<\/dt><dd>([^<]*)<\/dd>/)![1];
  assert.match(legend, /Brave’s public server-side code \(its swap backend repository\) switches this off for Zcash/);
  assert.match(legend, /deployed service is not public and could differ/);
  assert.match(sources.match(/<dt>Not verified<\/dt><dd>([^<]*)<\/dd>/)![1], /server-side switch it depends on could not be read/);

  const off = await siteWithSwitch(false);
  assert.match(bridgeCard(homePage(off, [], []).value), usableBadge, 'false: Bridge keeps its derived (usable) status');
  const statuses = (rows: { cells: { status: string }[] }[]) => rows.flatMap((r) => r.cells.map((c) => c.status));
  assert.deepEqual(statuses(presentCapabilities(off)), statuses(off.capabilities), 'false: nothing is lowered');
});

function mergedGroup(builds: (boolean | null)[] | null): SiteGroup {
  const base = structuredClone(site.groups[0]);
  const all = ['desktop', 'android', 'ios'].flatMap((platform) => ['release', 'beta', 'nightly'].map((channel) => ({ platform, channel })));
  return {
    ...base,
    id: 'brave/brave-core#990001',
    status: {
      ...base.status,
      stage: 'merged',
      stageLabel: STAGE_LABEL.merged,
      releaseNotes: [],
      implementation: { state: 'merged', mergedAt: '2026-01-01T00:00:00Z', prs: base.members.masterPrs },
      builds: (builds ?? []).map((included, i) => ({ ...all[i], version: '1.0.0', included, via: null, basis: 'test' })),
    },
  } as unknown as SiteGroup;
}
const nine = (v: boolean | null) => Array.from({ length: 9 }, () => v);

test('UI-C5 (repair): the stage label states absence only when every checked build confirms it', async () => {
  const { stageView, fixFacts } = await import('../src/site/view.ts');
  for (const builds of [null, nine(null)]) {
    const v = stageView(mergedGroup(builds));
    assert.equal(v.label, 'Merged, build presence unknown');
    assert.equal(v.unknown, true);
    assert.equal(v.stage, 'merged', 'filters and ?stage=merged links keep the derived id');
  }
  const mixedGroup = mergedGroup([false, false, ...nine(null).slice(2)]);
  assert.equal(stageView(mixedGroup).label, 'Merged, not confirmed in a current build');
  assert.equal(fixFacts(mixedGroup).inBuild, 'unknown');
  const absent = stageView(mergedGroup(nine(false)));
  assert.equal(absent.label, STAGE_LABEL.merged, 'explicit "not included" everywhere keeps the absence label');
  assert.equal(absent.unknown, false);
  for (const g of site.groups.filter((x) => x.status.stage !== 'merged')) assert.deepEqual(stageView(g), { stage: g.status.stage, label: g.status.stageLabel, unknown: false });
});

test('UI-C5 (repair): a merged fix with unknown build presence reads unknown on the detail, list, filter, search and legend', async () => {
  const { detailPage, workPage, groupStageBadge } = await import('../src/site/pages/work.ts');
  const { sourcesPage } = await import('../src/site/pages/other.ts');
  const { searchIndex } = await import('../src/site/view.ts');
  const g = mergedGroup(nine(null));
  const d = structuredClone(site);
  d.groups = [g, ...d.groups];
  d.stages = d.stages.map((s) => (s.id === 'merged' ? { ...s, count: s.count + 1 } : s));
  const absence = /not yet in a checked build/i;

  const detail = detailPage(g, d, {}, [], []).value;
  const head = detail.slice(detail.indexOf('<div class="page-head detail-head">'), detail.indexOf('<ul class="factstrip"'));
  assert.match(head, /<span class="stage st-merged"\s*><svg class="g g-not-verified"[^>]*><use href="#g-not-verified"\/><\/svg>Merged, build presence unknown<\/span>/);
  assert.doesNotMatch(detail, absence);
  assert.match(detail, /Unknown for all 9 current builds/, 'the badge agrees with the fact strip');

  const list = workPage(d).value;
  const row = list.match(/<li class="wrow"[^>]*data-stage="merged"[\s\S]*?<\/li>/)![0];
  assert.match(row, /Merged, build presence unknown/);
  assert.doesNotMatch(row, absence);
  assert.match(list, /<option value="merged">Merged, not confirmed in a current build \(\d+\)<\/option>/);
  assert.doesNotMatch(list.slice(0, list.indexOf('<ol class="work-list"')), absence, 'filter options');

  const entry = searchIndex(d, [], { feature: (id) => `/f/${id}/`, work: (id) => `/w/${id}/`, page: (p) => `/${p}` }).find((e) => e.k === 'Work' && e.u === `/w/${g.id}/`)!;
  assert.match(entry.s, /· Merged, build presence unknown$/);

  const legend = sourcesPage(d, [], {}).value.match(/<dt>Merged, not confirmed in a current build<\/dt><dd>([^<]*)<\/dd>/);
  assert.ok(legend, 'the stage legend uses the neutral merged label');
  assert.match(legend![1], /only when every checked build was confirmed not to include it/);

  // Explicit "not included" in every checked build still reads as absence, with the derived badge.
  const absent = groupStageBadge(mergedGroup(nine(false))).value;
  assert.ok(absent.includes(`</svg>${STAGE_LABEL.merged}</span>`), absent);
  assert.match(absent, /g-in-build/);
});

test('UI-C4/UI-C5 (repair): the built site carries no runtime-state claim and no unsupported absence label', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { buildSite } = await import('../src/site/build.ts');
  const { slug, setBase } = await import('../src/site/components.ts');
  const out = mkdtempSync(join(tmpdir(), 'zbt-site-'));
  try {
    await buildSite({ outDir: out, basePath: '/' });
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const pages = walk(out).filter((p) => p.endsWith('.html'));
    assert.ok(pages.length > 100);
    // Work pages whose derived stage legitimately states absence (every checked build says "not included").
    const absentOk = new Set(site.groups.filter((g) => g.status.stage === 'merged' && g.status.builds.length > 0 && g.status.builds.every((b) => b.included === false)).map((g) => join(out, 'work', slug(g.id), 'index.html')));
    for (const p of pages) {
      // <head> is skipped: its meta description is written by src/site/build.ts (outside this group's files)
      // from the derived stageLabel; that remaining spot is reported as a cross-group note.
      const body = readFileSync(p, 'utf8').replace(/<head>[\s\S]*?<\/head>/, '');
      assert.doesNotMatch(body, /currently turned off|turned off server-side|has this turned off/, p);
      if (absentOk.has(p)) continue;
      for (const m of body.matchAll(/not yet in a checked build/g)) {
        assert.match(body.slice(m.index! + 20, m.index! + 120), /only when every checked build was confirmed not to include it/, `${p}: absence wording outside its definition`);
      }
    }
    assert.doesNotMatch(readFileSync(join(out, 'assets', 'search.json'), 'utf8'), /not yet in a checked build|currently turned off/);
  } finally {
    setBase('/');
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 3 (R-SITE-STALE, R3-SITE-STALE-HEADER, R-SITE-EVENTS): the client agrees with the build, and the built-site
// scan covers <head> and capability-change event titles.
// ---------------------------------------------------------------------------

test('R3-SITE-STALE-HEADER / R-SITE-STALE: the client re-checks stale sources with the build’s rule, so pill, banner and Sources rows agree', async () => {
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const b = await boot({
    page: 'sources',
    url: 'https://example.test/tracker/sources/',
    setup: (doc) => {
      // The header as layout.ts renders it when one source's kept data turned stale only after the build.
      const pill = doc.createElement('a');
      pill.className = 'fresh';
      Object.assign(pill.dataset, { generated: ago(0.5), staleAfter: '360', failing: '0', stale: '0' });
      const count = doc.createElement('span');
      count.className = 'fresh-stale';
      pill.append(count);
      const banner = doc.createElement('div');
      banner.className = 'wrap source-stale-banner';
      banner.hidden = true;
      const ul = doc.createElement('ul');
      ul.className = 'stale-sources';
      for (const [id, h] of [['flags', 7], ['deps', 1]] as const) {
        const li = doc.createElement('li');
        li.id = `stale-${id}`;
        li.dataset.staleSince = ago(h);
        li.hidden = true;
        ul.append(li);
      }
      banner.append(ul);
      // A Sources row whose last success is recent while its kept data is stale (the verifier's trap).
      const tr = doc.createElement('tr');
      tr.className = 'src';
      tr.id = 'row-flags';
      Object.assign(tr.dataset, { lastSuccess: ago(1), outcome: 'partial' });
      const age = doc.createElement('span');
      age.className = 'src-age';
      Object.assign(age.dataset, { staleSince: ago(9), lastComplete: ago(9) });
      tr.append(age);
      const tr2 = doc.createElement('tr');
      tr2.className = 'src';
      tr2.id = 'row-deps';
      Object.assign(tr2.dataset, { lastSuccess: ago(0.5), outcome: 'partial' });
      const age2 = doc.createElement('span');
      age2.className = 'src-age';
      Object.assign(age2.dataset, { staleSince: '', lastComplete: ago(4) });
      tr2.append(age2);
      doc.body.append(pill, banner, tr, tr2);
    },
  });
  assert.equal(b.error, null);
  assert.deepEqual(b.errors, []);
  const pill = b.doc.querySelector('.fresh')!;
  assert.equal(pill.dataset.stale, '1');
  assert.ok(pill.classList.contains('has-stale'), 'the pill is marked');
  assert.equal(b.doc.querySelector('.fresh-stale')!.textContent, ' · 1 source stale');
  assert.equal(b.doc.querySelector('.source-stale-banner')!.hidden, false, 'the banner is shown');
  assert.equal(b.doc.getElementById('stale-flags')!.hidden, false);
  assert.equal(b.doc.getElementById('stale-deps')!.hidden, true, 'kept data within the window is not stale');
  const row = b.doc.getElementById('row-flags')!;
  assert.ok(row.classList.contains('is-stale'), 'the Sources row agrees with the header');
  assert.equal(row.querySelector('.src-age')!.textContent, 'stale: kept data not refreshed since 9 h ago · complete data from 9 h ago');
  const deps = b.doc.getElementById('row-deps')!;
  assert.ok(!deps.classList.contains('is-stale'));
  assert.equal(deps.querySelector('.src-age')!.textContent, 'partial · complete data from 4 h ago');
});

test('R-SITE-EVENTS: the built-site scan covers <head> (meta description) and capability-change event titles', async () => {
  const { readdirSync, statSync, cpSync } = await import('node:fs');
  const { buildSite } = await import('../src/site/build.ts');
  const { slug, setBase } = await import('../src/site/components.ts');
  const { presentCapabilities, statusLabel } = await import('../src/site/view.ts');
  const root = mkdtempSync(join(tmpdir(), 'zbt-site-r3-'));
  const data = join(root, 'data');
  cpSync(join(ROOT, 'data'), data, { recursive: true });
  // Capability changes recorded under older rules: one says the cell became usable while the site shows it otherwise.
  const shown = presentCapabilities(site);
  const rows = shown.filter((r) => r.cells.some((c) => c.platform === 'android' && c.channel === 'release' && c.status !== 'available')).slice(0, 3);
  assert.ok(rows.length > 0);
  const events = JSON.parse(readFileSync(join(data, 'history', 'events.json'), 'utf8'));
  const synthetic = rows.map((r, i) => ({ id: `r3scan${i}`, kind: 'capability-changed', sourceAt: null, detectedAt: site.generatedAt, basis: 'observed', title: `${r.name} on Android Release: absent → available`, impact: 'The evidence for this capability changed.', highlight: 'release', itemIds: [], topic: null, platforms: ['android'], channel: 'release', links: [], evidence: ['absent → available'] }));
  writeFileSync(join(data, 'history', 'events.json'), JSON.stringify([...synthetic, ...events]));
  // Site data derived before R-STAGE: a merged group whose stored label states absence while its builds are unknown.
  const copy = JSON.parse(readFileSync(join(data, 'derived', 'site.json'), 'utf8')) as SiteData;
  const g = copy.groups.find((x) => x.status.implementation.state === 'merged' && x.status.builds.length > 0 && x.status.stage !== 'merged')!;
  Object.assign(g.status, { stage: 'merged', stageLabel: STAGE_LABEL.merged, releaseNotes: [], builds: g.status.builds.map((x) => ({ ...x, included: null })) });
  writeFileSync(join(data, 'derived', 'site.json'), JSON.stringify(copy));
  const before = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = data;
  try {
    const out = join(root, 'out');
    await buildSite({ outDir: out, basePath: '/' });
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const absentOk = new Set(copy.groups.filter((x) => x.status.stage === 'merged' && x.status.builds.length > 0 && x.status.builds.every((y) => y.included === false)).map((x) => join(out, 'work', slug(x.id), 'index.html')));
    assert.match(readFileSync(join(out, 'work', slug(g.id), 'index.html'), 'utf8'), /<meta name="description" content="Merged, build presence unknown\. /);
    for (const p of walk(out).filter((x) => x.endsWith('.html'))) {
      const doc = readFileSync(p, 'utf8'); // <head> included
      assert.doesNotMatch(doc, /currently turned off|turned off server-side|has this turned off/, p);
      if (absentOk.has(p)) continue;
      for (const m of doc.matchAll(/not yet in a checked build/g)) assert.match(doc.slice(m.index! + 20, m.index! + 120), /only when every checked build was confirmed not to include it/, `${p}: absence wording outside its definition`);
    }
    for (const page of ['changes/index.html', 'index.html']) {
      const doc = readFileSync(join(out, page), 'utf8');
      for (const r of rows) {
        const cell = r.cells.find((c) => c.platform === 'android' && c.channel === 'release')!;
        const at = doc.indexOf(`${r.name} on Android Release: `);
        if (at < 0 && page === 'index.html') continue; // the home feed shows the latest few only
        assert.ok(at >= 0, `${page}: ${r.name} event rendered`);
        const item = doc.slice(at, doc.indexOf('</li>', at));
        assert.match(item, new RegExp(`Shown now: <span class="badge s-${cell.status}"[^>]*>[\\s\\S]*?<span>${statusLabel(cell.status, 'release')}</span>`), `${page}: ${r.name}`);
      }
    }
  } finally {
    if (before === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = before;
    setBase('/');
    rmSync(root, { recursive: true, force: true });
  }
});

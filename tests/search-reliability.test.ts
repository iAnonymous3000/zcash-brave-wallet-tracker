import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { createIndexLoader, isSearchEntry, type SearchEntry } from '../src/site/client/logic.ts';
import { page } from '../src/site/layout.ts';
import { html } from '../src/site/html.ts';

const entries: SearchEntry[] = [0, 1, 2].map((i) => ({ k: 'Work', t: `migrate ${i}`, s: `issue ${i}`, u: `/tracker/work/${i}/`, x: `migrate ${i}` }));
const bundled = build({ entryPoints: [resolve(import.meta.dirname, '../src/site/client/app.ts')], bundle: true, format: 'iife', write: false, logLevel: 'silent' }).then((r) => r.outputFiles[0].text);
const tick = () => new Promise((r) => setImmediate(r));

// A small DOM for the real bundle's search controls; no source data, servers or browser state.
class El {
  tagName: string;
  children: El[] = [];
  events: Record<string, ((event: any) => void)[]> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  hidden = false;
  open = false;
  value = '';
  className = '';
  target = '';
  href = '';
  rel = '';
  type = '';
  textContent = '';
  navigated: string[];
  active: { element: El | null };
  constructor(tag: string, navigated: string[], active: { element: El | null }) { this.tagName = tag.toUpperCase(); this.navigated = navigated; this.active = active; }
  classList = (() => { const names = new Set<string>(); return { add: (name: string) => { names.add(name); }, contains: (name: string) => names.has(name), toggle: (name: string, on: boolean) => on ? names.add(name) : names.delete(name) }; })();
  addEventListener(type: string, listener: (event: any) => void): void { (this.events[type] ??= []).push(listener); }
  fire(type: string, init: Record<string, unknown> = {}): any {
    const event = { target: this, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const listener of this.events[type] ?? []) listener(event);
    return event;
  }
  append(...elements: El[]): void { this.children.push(...elements); }
  replaceChildren(): void { this.children = []; }
  querySelectorAll(selector: string): El[] { return this.children.flatMap((child) => [...(selector === 'a' && child.tagName === 'A' ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): El | null { return this.querySelectorAll(selector)[0] ?? null; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  focus(): void { this.active.element = this; }
  select(): void {}
  scrollIntoView(): void {}
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.fire('close'); }
  click(): void { const event = this.fire('click'); if (!event.defaultPrevented && this.tagName === 'A') this.navigated.push(this.href); }
}

async function boot(fetcher: (call: number) => Promise<unknown> = async () => entries) {
  const navigated: string[] = [];
  const active = { element: null as El | null };
  const nodes = Object.fromEntries([['#search-dlg', 'dialog'], ['#sd-q', 'input'], ['#sd-results', 'ul'], ['#sd-status', 'p']].map(([id, tag]) => [id, new El(tag, navigated, active)]));
  const win: any = { addEventListener() {} };
  const errors: unknown[] = [];
  let calls = 0;
  vm.runInNewContext(await bundled, {
    document: { readyState: 'complete', body: { dataset: { page: 'home', base: '/tracker/' } }, querySelector: (s: string) => nodes[s] ?? null, querySelectorAll: () => [], getElementById: (id: string) => nodes[`#${id}`] ?? null, createElement: (tag: string) => new El(tag, navigated, active), addEventListener() {} },
    window: win, location: { href: 'https://example.test/tracker/', hash: '', search: '' },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} }, history: { replaceState() {} },
    Element: El, HTMLElement: El, HTMLDetailsElement: class extends El {}, HTMLInputElement: El, HTMLAnchorElement: El, Node: El,
    URL, URLSearchParams, Date, setTimeout, console: { error: (...args: unknown[]) => errors.push(args) },
    fetch: async () => ({ ok: true, json: async () => fetcher(++calls) }),
  });
  assert.deepEqual(errors, []);
  return { win, dlg: nodes['#search-dlg'], q: nodes['#sd-q'], list: nodes['#sd-results'], status: nodes['#sd-status'], active, navigated, calls: () => calls };
}

test('search entry validation rejects malformed text fields before caching and retries the next load', async () => {
  const malformed: unknown[] = [null, [], 'bad', {}, ...['k', 't', 's', 'u', 'x'].flatMap((field) => [{ ...entries[0], [field]: null }, { ...entries[0], [field]: 123 }])];
  assert.ok(isSearchEntry(entries[0]));
  for (const bad of malformed) {
    assert.equal(isSearchEntry(bad), false);
    let calls = 0;
    const loader = createIndexLoader<SearchEntry>(async () => ++calls === 1 ? [entries[0], bad] : entries, isSearchEntry);
    assert.equal(await loader.load(), 'failed');
    assert.equal(loader.entries, null, 'a partially valid array is not cached');
    assert.equal(await loader.load(), 'ready');
    assert.deepEqual(loader.entries, entries);
    assert.equal(calls, 2);
  }
  const empty = createIndexLoader<SearchEntry>(async () => [], isSearchEntry);
  assert.equal(await empty.load(), 'ready', 'an empty but valid index remains valid');
});

test('search selection announces its ordinal, kind, title and context while keeping native links and query focus', async () => {
  const b = await boot();
  b.q.value = 'migrate'; b.win.zbtOpenSearch(); await tick();
  assert.match(b.status.textContent, /^3 results for “migrate”/);
  assert.equal(b.active.element, b.q);
  b.q.fire('keydown', { key: 'ArrowUp' });
  assert.match(b.status.textContent, /^3 of 3\. Work: migrate 2\. issue 2\./);
  assert.equal(b.active.element, b.q);
  b.q.fire('keydown', { key: 'ArrowDown' });
  assert.match(b.status.textContent, /^1 of 3\. Work: migrate 0\. issue 0\./);
  const links = b.list.querySelectorAll('a');
  assert.equal(links[0].getAttribute('aria-label'), 'Work: migrate 0. issue 0');
  assert.equal(links[0].getAttribute('role'), null, 'results retain native link semantics');
  b.q.fire('keydown', { key: 'Enter' });
  assert.deepEqual(b.navigated, ['/tracker/work/0/']);
  assert.equal(b.dlg.open, false);
  assert.equal(b.status.textContent, '');
});

test('editing, empty results and reopening reset the keyboard selection without breaking mouse activation', async () => {
  const b = await boot();
  b.q.value = 'migrate'; b.win.zbtOpenSearch(); await tick();
  b.q.fire('keydown', { key: 'ArrowUp' });
  b.q.value = 'not-found'; b.q.fire('input');
  assert.equal(b.status.textContent, 'No results for “not-found”.');
  assert.equal(b.list.querySelectorAll('a').length, 0);
  b.q.value = ''; b.q.fire('input');
  assert.equal(b.status.textContent, '');
  b.dlg.close(); b.q.value = 'migrate'; b.win.zbtOpenSearch(); await tick();
  assert.match(b.status.textContent, /^3 results/);
  assert.ok(b.list.querySelectorAll('a').every((link) => !link.classList.contains('is-active')));
  b.list.querySelectorAll('a')[1].click();
  assert.deepEqual(b.navigated, ['/tracker/work/1/']);
  assert.equal(b.dlg.open, false);
  assert.equal(b.calls(), 1, 'successful index remains cached');
});

test('malformed search entries use the announced unavailable state and recover through button, Enter and reopen', async () => {
  for (const retry of ['button', 'enter', 'reopen']) {
    const b = await boot(async (call) => call === 1 ? [null] : entries);
    b.q.value = 'migrate'; b.win.zbtOpenSearch(); await tick();
    assert.match(b.status.textContent, /Search is unavailable/);
    assert.equal(b.list.querySelectorAll('a').length, 0);
    const button = b.list.children[0].children[0];
    assert.equal(button.tagName, 'BUTTON');
    if (retry === 'button') button.click();
    if (retry === 'enter') b.q.fire('keydown', { key: 'Enter' });
    if (retry === 'reopen') { b.dlg.close(); b.win.zbtOpenSearch(); }
    await tick();
    assert.equal(b.calls(), 2, retry);
    assert.equal(b.list.querySelectorAll('a').length, 3, retry);
    assert.match(b.status.textContent, /^3 results/, retry);
  }
});

test('the rendered dialog exposes a polite atomic status and describes its keyboard controls', () => {
  const out = page({ title: 'Search test', description: '', path: '', active: 'home' }, { generatedAt: '2026-10-09T00:00:00Z', lastRunAt: null, lastRunOutcome: null, sources: [], mode: 'live' }, html``);
  assert.match(out, /id="sd-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(out, /id="sd-q"[^>]*aria-describedby="sd-hint"/);
  assert.match(out, /id="sd-hint"/);
});

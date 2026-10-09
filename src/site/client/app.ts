// Client-side enhancements. Every page is fully server-rendered; this script only
// adds relative times, staleness checks computed at view time, selectors and filters.
// It never inserts fetched text as HTML (no innerHTML). Pure logic lives in ./logic.ts.

import { createIndexLoader, filterForTarget, hashId, keptDataStale, nextIndex, rankSearch, runIsolated, safeHref, samePageFragment, sourceAgeLine, staleCountText, tokens, type SearchEntry } from './logic.ts';

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];

function ago(iso: string): { text: string; minutes: number } {
  const ms = Date.now() - Date.parse(iso);
  const minutes = Math.round(ms / 60000);
  if (!Number.isFinite(minutes)) return { text: 'unknown', minutes: NaN };
  if (minutes < 1) return { text: 'just now', minutes };
  if (minutes < 60) return { text: `${minutes} min ago`, minutes };
  const h = Math.round(minutes / 60);
  if (h < 48) return { text: `${h} h ago`, minutes };
  const d = Math.round(h / 24);
  return { text: `${d} days ago`, minutes };
}

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode, blocked) */
  }
  return null;
}

function relTimes(): void {
  for (const t of $$<HTMLTimeElement>('time[data-rel]')) {
    const iso = t.getAttribute('datetime');
    if (!iso) continue;
    const a = ago(iso);
    const local = new Date(iso).toLocaleString();
    t.textContent = a.text;
    t.title = `${local} (${iso})`;
  }
}

function freshness(): void {
  const el = $<HTMLAnchorElement>('.fresh');
  if (!el) return;
  const gen = el.dataset.generated ?? '';
  const staleAfter = Number(el.dataset.staleAfter ?? '360');
  const failing = Number(el.dataset.failing ?? '0');
  const a = ago(gen);
  const now = Date.now();
  if (failing > 0) el.classList.add('has-failing');
  if (!Number.isFinite(a.minutes) || a.minutes > staleAfter) {
    el.classList.add('is-stale');
    const banner = $('.stale-banner');
    const text = $('.stale-text');
    if (banner && text) {
      text.textContent = `The last refresh finished ${a.text}; refreshes normally run every few hours, so newer upstream changes may be missing.`;
      banner.hidden = false;
    }
  }
  // Sources whose kept data is stale: the same rule as the header rendered at build time (staleSources),
  // re-checked with this clock, so the pill, the banner and the Sources page agree.
  const watched = $$('.stale-sources li');
  if (watched.length || el.dataset.stale !== undefined) {
    let stale = 0;
    for (const li of watched) {
      const on = keptDataStale({ staleSince: li.dataset.staleSince ?? '' }, now, staleAfter);
      li.hidden = !on;
      if (on) stale += 1;
    }
    if (!watched.length) stale = Number(el.dataset.stale ?? '0') || 0;
    el.dataset.stale = String(stale);
    el.classList.toggle('has-stale', stale > 0);
    const count = $('.fresh-stale', el);
    if (count) count.textContent = staleCountText(stale);
    const banner = $('.source-stale-banner');
    if (banner) banner.hidden = stale === 0;
  }
  // Per-source ages on the Sources page.
  for (const row of $$('.src')) {
    const age = $('.src-age', row);
    if (!age) continue;
    const r = sourceAgeLine({ lastOutcome: row.dataset.outcome ?? null, lastSuccessAt: row.dataset.lastSuccess || null, lastCompleteAt: age.dataset.lastComplete || null, staleSince: age.dataset.staleSince || null }, now, staleAfter);
    age.textContent = r.text;
    row.classList.toggle('is-stale', r.stale);
  }
}

// ---------------------------------------------------------------------------
// Home: platform + channel picker driving every [data-k] / [data-p] variant
// ---------------------------------------------------------------------------

function capabilitySelector(): void {
  const pBtns = $$<HTMLButtonElement>('.psel');
  const cBtns = $$<HTMLButtonElement>('.csel');
  if (!pBtns.length || !cBtns.length) return;
  const ps = pBtns.map((b) => b.dataset.platform ?? '');
  const cs = cBtns.map((b) => b.dataset.channel ?? '');
  const params = new URLSearchParams(location.search);
  let p = params.get('platform') ?? store('zbt-platform') ?? 'desktop';
  let c = params.get('channel') ?? store('zbt-channel') ?? 'release';
  if (!ps.includes(p)) p = 'desktop';
  if (!cs.includes(c)) c = 'release';

  const apply = (persist: boolean) => {
    const k = `${p}/${c}`;
    for (const b of pBtns) b.setAttribute('aria-pressed', String(b.dataset.platform === p));
    for (const b of cBtns) b.setAttribute('aria-pressed', String(b.dataset.channel === c));
    for (const el of $$('.status-block [data-k]')) el.hidden = el.dataset.k !== k;
    for (const el of $$('.status-block [data-p]')) el.hidden = el.dataset.p !== p;
    if (!persist) return;
    store('zbt-platform', p);
    store('zbt-channel', c);
    const url = new URL(location.href);
    url.searchParams.set('platform', p);
    url.searchParams.set('channel', c);
    history.replaceState(null, '', url);
  };
  for (const b of pBtns) b.addEventListener('click', () => { p = b.dataset.platform ?? 'desktop'; apply(true); });
  for (const b of cBtns) b.addEventListener('click', () => { c = b.dataset.channel ?? 'release'; apply(true); });
  apply(false);
}

/** Releases page: platform filter. Set by releaseFilter(); reveals a release the filter hides. */
let revealRelease: ((el: HTMLElement) => boolean) | null = null;

function releaseFilter(): void {
  const btns = $$<HTMLButtonElement>('.rfilter');
  if (!btns.length) return;
  const empty = $('#rel-empty');
  let current = btns.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.platform ?? '';
  const set = (p: string) => {
    current = p;
    for (const b of btns) b.setAttribute('aria-pressed', String((b.dataset.platform ?? '') === p));
    let shown = 0;
    for (const v of $$('.rel-v')) {
      v.hidden = Boolean(p) && v.dataset.platform !== p;
      if (!v.hidden) shown += 1;
    }
    if (empty) empty.hidden = shown > 0;
  };
  for (const b of btns) b.addEventListener('click', () => set(b.dataset.platform ?? ''));
  revealRelease = (el) => {
    const rel = el.closest<HTMLElement>('.rel-v');
    if (!rel) return false;
    const next = filterForTarget(current, rel.dataset.platform);
    if (next === current) return false;
    set(next);
    return true;
  };
}

/**
 * Make the element a fragment names visible: switch a Releases filter that hides it and open a
 * <details>. Returns the element and whether anything had to change.
 */
function revealTarget(id: string | null): { el: HTMLElement; changed: boolean } | null {
  const el = id ? document.getElementById(id) : null;
  if (!el) return null;
  let changed = revealRelease?.(el) ?? false;
  if (el instanceof HTMLDetailsElement && !el.open) {
    el.open = true;
    changed = true;
  }
  return { el, changed };
}

// ---------------------------------------------------------------------------
// Site search (index built at build time, same origin; results rendered as text)
// ---------------------------------------------------------------------------

function search(): void {
  const dlg = $<HTMLDialogElement>('#search-dlg');
  const q = $<HTMLInputElement>('#sd-q');
  const list = $<HTMLUListElement>('#sd-results');
  if (!dlg || !q || !list || typeof dlg.showModal !== 'function') return;
  let active = -1;
  const loader = createIndexLoader<SearchEntry>(async () => {
    const res = await fetch(`${document.body.dataset.base ?? '/'}assets/search.json`);
    if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
    return res.json();
  });

  const note = (text: string, cls = '') => {
    const li = document.createElement('li');
    li.className = cls ? `sd-none ${cls}` : 'sd-none';
    li.textContent = text;
    list.append(li);
    return li;
  };
  const render = () => {
    list.replaceChildren();
    active = -1;
    if (loader.state === 'failed') {
      // Never shown as "nothing matches": the index itself is missing.
      const li = note('Search is unavailable: the search index could not be loaded. ', 'sd-error');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'sd-retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => void refresh());
      li.append(retry);
      return;
    }
    if (!tokens(q.value).length) return;
    if (loader.state !== 'ready' || !loader.entries) {
      note('Loading the search index…');
      return;
    }
    const hits = rankSearch(loader.entries, q.value);
    if (!hits.length) {
      note(`Nothing matches “${q.value.trim()}”. Try an issue number or a shorter word.`);
      return;
    }
    for (const e of hits) {
      const safe = safeHref(e.u);
      if (!safe) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = safe;
      if (/^https:/.test(safe)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
      }
      a.addEventListener('click', (ev) => activate(a, ev));
      const k = document.createElement('span');
      k.className = 'sd-k';
      k.textContent = e.k;
      const t = document.createElement('span');
      t.className = 'sd-t';
      t.textContent = e.t;
      const sub = document.createElement('span');
      sub.className = 'sd-s';
      sub.textContent = e.s;
      a.append(k, t, sub);
      li.append(a);
      list.append(li);
    }
  };
  /** Load (or retry) the index, showing the state before and after. */
  const refresh = async () => {
    const pending = loader.load();
    render();
    await pending;
    render();
  };
  /**
   * A result was chosen. Close the dialog so the destination is not left under it. For a target
   * on this page, make it visible now (e.g. switch a Releases filter that hides it), before the
   * browser's own fragment navigation scrolls to it; that also covers choosing the fragment the
   * page is already on, which fires no hashchange.
   */
  const activate = (a: HTMLAnchorElement, ev: MouseEvent) => {
    if (ev.defaultPrevented || (ev.button ?? 0) !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (a.target === '_blank') return; // opens in another tab; keep the search open here
    const id = samePageFragment(a.href, location.href);
    if (dlg.open) dlg.close();
    if (id !== null) revealTarget(id);
  };
  const move = (delta: number) => {
    const links = $$<HTMLAnchorElement>('a', list);
    active = nextIndex(active, delta, links.length);
    if (active < 0) return;
    links.forEach((l, i) => l.classList.toggle('is-active', i === active));
    links[active].scrollIntoView({ block: 'nearest' });
  };
  const open = async () => {
    if (!dlg.open) dlg.showModal();
    q.focus();
    q.select();
    await refresh();
  };
  for (const el of $$('[data-search-open]')) el.addEventListener('click', (e) => { e.preventDefault(); void open(); });
  for (const el of $$('[data-search-close]')) el.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  q.addEventListener('input', render);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      if (loader.state === 'failed') { e.preventDefault(); void refresh(); return; }
      const links = $$<HTMLAnchorElement>('a', list);
      const target = links[active] ?? links[0];
      if (target) { e.preventDefault(); target.click(); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); void open(); }
  });
  (window as unknown as { zbtOpenSearch: () => void }).zbtOpenSearch = () => void open();
}

/** Close the mobile menu after navigation, on Escape and on outside clicks. */
function menu(): void {
  const m = $<HTMLDetailsElement>('.menu');
  if (!m) return;
  document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target as Node)) m.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.open) { m.open = false; (m.querySelector('summary') as HTMLElement | null)?.focus(); } });
}

/**
 * Follow the URL fragment on load and on every later change: open a <details> it names and
 * reveal a release that the platform filter hides. A malformed fragment (e.g. "#%ZZ") is looked
 * up as written and never throws.
 */
function hashTargets(): void {
  // Old overview links (#cap-<feature>) now live on the feature pages.
  const legacy = location.hash.match(/^#cap-([a-z0-9-]+)$/);
  if (legacy && document.body.dataset.page === 'home') {
    location.replace(`${document.body.dataset.base ?? '/'}features/${legacy[1]}/`);
    return;
  }
  const sync = () => {
    const r = revealTarget(hashId(location.hash));
    // The browser cannot scroll to a target that was hidden when the fragment changed.
    if (r?.changed) r.el.scrollIntoView();
  };
  window.addEventListener('hashchange', sync);
  sync();
}

// ---------------------------------------------------------------------------
// "New since your last visit": a per-browser marker, never shown on stale data
// ---------------------------------------------------------------------------

function newSinceLastVisit(): void {
  const fresh = $<HTMLAnchorElement>('.fresh');
  const gen = fresh?.dataset.generated;
  if (!fresh || !gen) return;
  let prev = '';
  try {
    // The previous visit's data time is fixed for this browsing session so every page agrees.
    const held = sessionStorage.getItem('zbt-prev-seen');
    prev = held ?? localStorage.getItem('zbt-seen') ?? '';
    if (held === null) sessionStorage.setItem('zbt-prev-seen', prev);
    const last = localStorage.getItem('zbt-seen');
    if (!last || last < gen) localStorage.setItem('zbt-seen', gen);
  } catch {
    return; // storage unavailable: show no markers rather than guess
  }
  if (!prev) return; // first visit: nothing is "new" yet
  if (fresh.classList.contains('is-stale') || fresh.classList.contains('has-failing') || fresh.classList.contains('has-stale')) return;
  const fresh_ = $$('[data-detected]').filter((el) => (el.dataset.detected ?? '') > prev);
  for (const el of fresh_) {
    el.classList.add('is-new');
    const tag = $('.new-tag', el);
    if (tag) tag.hidden = false;
  }
  if (!fresh_.length) return;
  for (const c of $$('.new-count')) {
    c.textContent = document.body.dataset.page === 'home' ? `${fresh_.length} new here since your last visit` : `${fresh_.length} new since your last visit`;
    c.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Generic list filtering (work, changes, reports)
// ---------------------------------------------------------------------------

interface FilterSpec {
  form: string;
  list: string;
  item: string;
  count: string;
  empty: string;
  noun: [string, string];
  /** control id -> how it matches */
  controls: { id: string; param: string; match: (el: HTMLElement, value: string) => boolean }[];
  radios?: { name: string; param: string; match: (el: HTMLElement, value: string) => boolean };
  sort?: { id: string; param: string };
}

function setupFilter(spec: FilterSpec): void {
  const form = $<HTMLFormElement>(spec.form);
  const list = $(spec.list);
  if (!form || !list) return;
  const items = $$<HTMLElement>(spec.item, list);
  const count = $(spec.count);
  const empty = $(spec.empty);
  const params = new URLSearchParams(location.search);
  for (const c of spec.controls) {
    const el = document.getElementById(c.id) as HTMLInputElement | HTMLSelectElement | null;
    const v = params.get(c.param);
    if (el && v !== null) el.value = v;
  }
  if (spec.radios) {
    const v = params.get(spec.radios.param);
    if (v !== null) for (const r of $$<HTMLInputElement>(`input[name="${spec.radios.name}"]`, form)) r.checked = r.value === v;
  }
  if (spec.sort) {
    const el = document.getElementById(spec.sort.id) as HTMLSelectElement | null;
    const v = params.get(spec.sort.param);
    if (el && v) el.value = v;
  }

  const apply = () => {
    let shown = 0;
    const url = new URL(location.href);
    const active: [FilterSpec['controls'][number], string][] = [];
    for (const c of spec.controls) {
      const el = document.getElementById(c.id) as HTMLInputElement | HTMLSelectElement | null;
      const v = (el?.value ?? '').trim();
      if (v) {
        active.push([c, v]);
        url.searchParams.set(c.param, v);
      } else url.searchParams.delete(c.param);
    }
    let radioVal = '';
    if (spec.radios) {
      radioVal = $$<HTMLInputElement>(`input[name="${spec.radios.name}"]`, form).find((r) => r.checked)?.value ?? '';
      if (radioVal) url.searchParams.set(spec.radios.param, radioVal);
      else url.searchParams.delete(spec.radios.param);
    }
    for (const it of items) {
      let ok = active.every(([c, v]) => c.match(it, v));
      if (ok && spec.radios && radioVal) ok = spec.radios.match(it, radioVal);
      it.hidden = !ok;
      if (ok) shown += 1;
    }
    if (spec.sort) {
      const el = document.getElementById(spec.sort.id) as HTMLSelectElement | null;
      const mode = el?.value ?? '';
      if (mode && mode !== 'updated') url.searchParams.set(spec.sort.param, mode);
      else url.searchParams.delete(spec.sort.param);
      const key = (x: HTMLElement) => (mode === 'created' ? x.dataset.created ?? '' : mode === 'number' ? String(Number(x.dataset.number ?? 0)).padStart(8, '0') : x.dataset.updated ?? '');
      const sorted = [...items].sort((a, b) => key(b).localeCompare(key(a)));
      for (const s of sorted) list.appendChild(s);
    }
    if (count) count.textContent = `${shown} of ${items.length} ${items.length === 1 ? spec.noun[0] : spec.noun[1]}`;
    if (empty) empty.hidden = shown !== 0;
    history.replaceState(null, '', url);
  };
  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('reset', () => setTimeout(apply, 0));
  apply();
}

const textMatch = (el: HTMLElement, v: string) => {
  const hay = el.dataset.text ?? '';
  return tokens(v).every((t) => hay.includes(t));
};

function filters(): void {
  setupFilter({
    form: '#work-filters',
    list: '#work-list',
    item: '.wrow',
    count: '#work-count',
    empty: '#work-empty',
    noun: ['group', 'groups'],
    controls: [
      { id: 'wq', param: 'q', match: textMatch },
      { id: 'wstage', param: 'stage', match: (el, v) => el.dataset.stage === v },
      { id: 'wtopic', param: 'topic', match: (el, v) => el.dataset.topic === v },
      { id: 'wkind', param: 'kind', match: (el, v) => el.dataset.kind === v },
      { id: 'wplat', param: 'platform', match: (el, v) => (el.dataset.platforms ?? '').split(' ').includes(v) },
      { id: 'wstate', param: 'state', match: (el, v) => el.dataset.state === v },
      { id: 'wrel', param: 'relevance', match: (el, v) => el.dataset.relevance === v },
    ],
    sort: { id: 'wsort', param: 'sort' },
  });
  setupFilter({
    form: '#change-filters',
    list: '#change-feed',
    item: '.ev',
    count: '#change-count',
    empty: '#change-empty',
    noun: ['change', 'changes'],
    controls: [
      { id: 'cq', param: 'q', match: textMatch },
      { id: 'cscope', param: 'scope', match: (el, v) => el.dataset.scope === v },
      { id: 'ctopic', param: 'topic', match: (el, v) => el.dataset.topic === v },
      { id: 'cbasis', param: 'basis', match: (el, v) => el.dataset.basis === v },
    ],
    radios: { name: 'hl', param: 'highlight', match: (el, v) => el.dataset.highlight === v },
  });
  setupFilter({
    form: '#report-filters',
    list: '#report-list',
    item: '.report',
    count: '#report-count',
    empty: '#report-empty',
    noun: ['thread', 'threads'],
    controls: [
      { id: 'rq', param: 'q', match: textMatch },
      { id: 'rlink', param: 'link', match: (el, v) => el.dataset.linked === v },
    ],
  });
}

function keyboard(): void {
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const filter = $<HTMLInputElement>('.filters input[type="search"]');
      if (filter) filter.focus();
      else (window as unknown as { zbtOpenSearch?: () => void }).zbtOpenSearch?.();
    }
    if (e.key === 'Escape' && target instanceof HTMLInputElement && target.type === 'search' && target.value) {
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

/** Each step is independent: one that throws (unexpected markup, blocked storage, odd URLs) cannot stop the rest. */
function init(): void {
  runIsolated(
    [
      ['relative times', relTimes],
      ['freshness', freshness],
      ['capability selector', capabilitySelector],
      ['release filter', releaseFilter],
      ['fragment targets', hashTargets],
      ['list filters', filters],
      ['new since last visit', newSinceLastVisit],
      ['search', search],
      ['menu', menu],
      ['keyboard', keyboard],
    ],
    (name, err) => console.error(`tracker: ${name} setup failed`, err),
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

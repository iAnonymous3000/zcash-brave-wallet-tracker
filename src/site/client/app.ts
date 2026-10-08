// Client-side enhancements. Every page is fully server-rendered; this script only
// adds relative times, staleness checks computed at view time, selectors and filters.
// It never inserts fetched text as HTML (no innerHTML).

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
  // Per-source ages on the Sources page.
  for (const row of $$('.src')) {
    const last = row.dataset.lastSuccess;
    const age = $('.src-age', row);
    if (!age) continue;
    if (!last) {
      age.textContent = 'never succeeded';
      row.classList.add('is-stale');
      continue;
    }
    const r = ago(last);
    const stale = r.minutes > staleAfter;
    age.textContent = stale ? `stale: last success ${r.text}` : `data age ${r.text}`;
    if (stale) row.classList.add('is-stale');
  }
}

// ---------------------------------------------------------------------------
// Home: build picker (platform × channel) driving the capability detail column
// ---------------------------------------------------------------------------

const keyOf = (el: HTMLElement) => `${el.dataset.platform}/${el.dataset.channel}`;

function capabilitySelector(): void {
  const buttons = $$<HTMLButtonElement>('.bsel');
  if (!buttons.length) return;
  const keys = buttons.map(keyOf);
  const params = new URLSearchParams(location.search);
  const initial = `${params.get('platform') ?? store('zbt-platform') ?? 'desktop'}/${params.get('channel') ?? store('zbt-channel') ?? 'release'}`;
  const head = $('#sel-head');

  const select = (k: string, persist: boolean) => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(keyOf(b) === k));
    for (const b of $$<HTMLButtonElement>('.mx-btn')) b.setAttribute('aria-pressed', String(keyOf(b) === k));
    for (const el of $$('.dv, .bb')) el.hidden = el.dataset.k !== k;
    for (const el of $$('.mx-ch, .mx-cell')) el.classList.toggle('is-sel', el.dataset.k === k);
    const th = $(`.mx-ch[data-k="${k}"]`);
    if (head && th) head.textContent = th.getAttribute('title') ?? '';
    if (!persist) return;
    const [p, c] = k.split('/');
    store('zbt-platform', p);
    store('zbt-channel', c);
    const url = new URL(location.href);
    url.searchParams.set('platform', p);
    url.searchParams.set('channel', c);
    history.replaceState(null, '', url);
  };
  for (const b of buttons) b.addEventListener('click', () => select(keyOf(b), true));
  for (const b of $$<HTMLButtonElement>('.mx-btn')) b.addEventListener('click', () => select(keyOf(b), true));
  select(keys.includes(initial) ? initial : 'desktop/release', false);
}

/** Open a <details> section when the URL points at it (e.g. #cap-ironwood). */
function openHashTarget(): void {
  const open = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id ? document.getElementById(id) : null;
    if (el instanceof HTMLDetailsElement) el.open = true;
  };
  window.addEventListener('hashchange', open);
  open();
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
  if (fresh.classList.contains('is-stale') || fresh.classList.contains('has-failing')) return;
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

function tokens(q: string): string[] {
  return q.toLowerCase().replace(/#/g, ' ').split(/\s+/).filter(Boolean);
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
      const search = $<HTMLInputElement>('input[type="search"]');
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
    if (e.key === 'Escape' && target instanceof HTMLInputElement && target.type === 'search' && target.value) {
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function init(): void {
  relTimes();
  freshness();
  capabilitySelector();
  openHashTarget();
  filters();
  newSinceLastVisit();
  keyboard();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

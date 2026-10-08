// Shared view helpers. Everything goes through html`` (escaped by default).

import type { Channel, Platform } from '../lib/types.ts';
import { ext, html, raw, type SafeHtml } from './html.ts';

export const PLATFORM_NAME: Record<Platform, string> = { desktop: 'Desktop', android: 'Android', ios: 'iOS' };
export const CHANNEL_NAME: Record<Channel, string> = { release: 'Release', beta: 'Beta', nightly: 'Nightly' };

let BASE = '/';
export function setBase(b: string): void {
  BASE = b.endsWith('/') ? b : `${b}/`;
}
/** Site-internal URL respecting the GitHub Pages base path. */
export function u(path = ''): string {
  return `${BASE}${path.replace(/^\//, '')}`;
}

export function slug(id: string): string {
  return id.replace(/^brave\//, '').replace(/[#/]/g, '-');
}

export function shortRef(id: string): string {
  return id.replace(/^brave\/brave-browser#/, 'brave-browser#').replace(/^brave\/brave-core#/, 'brave-core#');
}

export function itemHref(groupId: string): string {
  return u(`work/${slug(groupId)}/`);
}

/** <time> with an absolute UTC fallback; the client upgrades it to relative/local. */
export function time(iso: string | null | undefined, opts: { rel?: boolean; withTime?: boolean } = {}): SafeHtml {
  if (!iso) return html`<span class="muted">unknown</span>`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return html`<span class="muted">unknown</span>`;
  const text = opts.withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
  return html`<time datetime="${iso}" ${opts.rel ? raw('data-rel') : ''} title="${iso}">${text}</time>`;
}

export function chip(label: string, cls: string, title?: string): SafeHtml {
  return html`<span class="chip ${cls}" ${title ? raw(`title="${escapeAttr(title)}"`) : ''}>${label}</span>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Status glyphs carry meaning without colour (shape + text). */
export const CELL_GLYPH: Record<string, string> = {
  available: '●',
  'in-build': '◐',
  'opt-in': '◇',
  off: '○',
  absent: '–',
  'not-planned': '✕',
  'not-verified': '?',
};

export function cellBadge(status: string, label: string, help?: string): SafeHtml {
  return html`<span class="cell cell-${status}" ${help ? raw(`title="${escapeAttr(help)}"`) : ''}><span class="glyph" aria-hidden="true">${CELL_GLYPH[status] ?? '?'}</span><span class="cell-label">${label}</span></span>`;
}

export const STAGE_CLASS: Record<string, string> = {
  released: 'st-released',
  'in-release-build': 'st-build',
  'in-beta': 'st-build',
  'in-nightly': 'st-build',
  merged: 'st-merged',
  'in-progress': 'st-progress',
  open: 'st-open',
  'closed-unverified': 'st-closed',
  'closed-unmerged': 'st-closed',
  'not-planned': 'st-np',
  duplicate: 'st-dup',
};

export function ghLink(id: string, url: string, label?: string): SafeHtml {
  return ext(url, label ?? shortRef(id), 'ref');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export { ext, html, raw };

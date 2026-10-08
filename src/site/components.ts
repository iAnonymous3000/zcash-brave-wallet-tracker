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

/** Status glyphs: the shape carries the meaning, colour only reinforces it. Drawn once per page as an SVG sprite. */
const GLYPH_PATHS: Record<string, string> = {
  available: '<circle cx="8" cy="8" r="6" fill="currentColor"/>',
  'in-build': '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor"/>',
  'opt-in': '<rect x="1.6" y="4.4" width="12.8" height="7.2" rx="3.6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.3" cy="8" r="1.9" fill="currentColor"/>',
  off: '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  'service-off': '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.3 11.7l7.4-7.4" stroke="currentColor" stroke-width="1.6"/>',
  absent: '<path d="M4 8h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'not-planned': '<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  'not-verified': '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.1 2.1"/>',
  progress: '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2.6a5.4 5.4 0 0 1 5.4 5.4H8z" fill="currentColor"/>',
  open: '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>',
  warn: '<path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.6v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".9" fill="currentColor"/>',
};
export const GLYPH_SPRITE = `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">${Object.entries(GLYPH_PATHS).map(([k, v]) => `<symbol id="g-${k}" viewBox="0 0 16 16">${v}</symbol>`).join('')}</svg>`;

/** Inline status glyph (decorative; always paired with a text label). */
export function glyph(kind: string, cls = ''): SafeHtml {
  const k = GLYPH_PATHS[kind] ? kind : 'not-verified';
  return raw(`<svg class="g g-${k}${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#g-${k}"/></svg>`);
}

export function cellBadge(status: string, label: string, help?: string): SafeHtml {
  return html`<span class="cell cell-${status}" ${help ? raw(`title="${escapeAttr(help)}"`) : ''}>${glyph(status)}<span class="cell-label">${label}</span></span>`;
}

export const STAGE_CLASS: Record<string, string> = {
  released: 'st-released',
  'in-release-build': 'st-build',
  'in-beta': 'st-build',
  'in-nightly': 'st-build',
  merged: 'st-merged',
  'service-change': 'st-merged',
  'in-progress': 'st-progress',
  open: 'st-open',
  'closed-unverified': 'st-closed',
  'closed-unmerged': 'st-closed',
  'not-planned': 'st-np',
  duplicate: 'st-dup',
};

const STAGE_GLYPH: Record<string, string> = {
  released: 'available',
  'in-release-build': 'in-build',
  'in-beta': 'in-build',
  'in-nightly': 'in-build',
  merged: 'in-build',
  'service-change': 'in-build',
  'in-progress': 'progress',
  open: 'open',
  'closed-unverified': 'not-verified',
  'closed-unmerged': 'absent',
  'not-planned': 'not-planned',
  duplicate: 'not-planned',
};

/** Work stage as glyph + label. */
export function stageBadge(stage: string, label: string, title?: string): SafeHtml {
  return html`<span class="stage ${STAGE_CLASS[stage] ?? ''}" ${title ? raw(`title="${escapeAttr(title)}"`) : ''}>${glyph(STAGE_GLYPH[stage] ?? 'open')}${label}</span>`;
}

export function ghLink(id: string, url: string, label?: string): SafeHtml {
  return ext(url, label ?? shortRef(id), 'ref');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export { ext, html, raw };

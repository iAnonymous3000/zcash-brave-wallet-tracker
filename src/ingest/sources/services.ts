// Public server-side signals that change Zcash behaviour without a browser release:
//  - brave/gate3 (swap/bridge routing backend): whether Zcash is in SWAP_DISABLED_CHAINS
//  - brave/brave-variations (Griffin field trials): studies touching Zcash features/params
// Both are read from the public repositories; the deployed services could differ from
// the repository state, which the site states explicitly.

import type { Collector } from '../framework.ts';
import type { ReleasesData } from './releases.ts';
import { compareVersions } from '../../lib/util.ts';

export interface StudyInfo {
  file: string;
  name: string;
  features: { enable: string[]; disable: string[] };
  params: Record<string, string>;
  minVersion: string | null;
  maxVersion: string | null;
  channels: string[];
  platforms: string[];
  probability: number | null;
  /** Chromium-based Brave version the study's range is compared with, per current build ("155.1.97.56"). */
  appliesTo: { build: string; applies: boolean }[];
  url: string;
}

export interface ServicesData {
  gate3: { commitSha: string; file: string; zcashDisabled: boolean | null; line: number | null; url: string; checkedAt: string } | null;
  studies: StudyInfo[];
  studiesCommit: string | null;
}

const GATE3_FILE = 'app/api/swap/constants.py';

/** Tolerant JSON5 → JSON for Brave's study files (comments, single quotes, unquoted keys, trailing commas). */
export function json5ToJson(src: string): unknown {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")));
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(s);
}

/** "139.1.81.129" / "152.*" style range check against a full version like "155.1.97.56". */
export function inStudyRange(full: string, min: string | null, max: string | null): boolean {
  const norm = (v: string, wildcard: string) => v.replace(/\*/g, wildcard);
  if (min && compareVersions(full, norm(min, '0')) < 0) return false;
  if (max && compareVersions(full, norm(max, '99999')) > 0) return false;
  return true;
}

export const services: Collector<ServicesData> = {
  id: 'brave-services',
  name: 'Brave server-side signals (gate3 swap routing, brave-variations studies)',
  url: 'https://github.com/brave/gate3',
  schema: 1,
  dependsOn: ['brave-releases'],
  budget: { 'github-core': 12 },
  async collect(ctx) {
    const limitations: string[] = ['Repository state is shown; the deployed service could differ and its deployment time is not public'];
    // gate3 swap routing.
    let gate3: ServicesData['gate3'] = null;
    const gsha = await ctx.gh.commitSha('brave/gate3', 'master');
    if (!gsha) throw new Error('brave/gate3 master not reachable');
    const res = await ctx.http.request(`https://raw.githubusercontent.com/brave/gate3/${gsha}/${GATE3_FILE}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
    if (res.status === 404) {
      await res.text();
      limitations.push(`${GATE3_FILE} not found in brave/gate3 (layout changed?)`);
      gate3 = { commitSha: gsha, file: GATE3_FILE, zcashDisabled: null, line: null, url: `https://github.com/brave/gate3/tree/${gsha}`, checkedAt: ctx.now };
    } else {
      const text = await res.text();
      const lines = text.split('\n');
      const start = lines.findIndex((l) => /SWAP_DISABLED_CHAINS/.test(l));
      let disabled: boolean | null = null;
      if (start !== -1) {
        const block = lines.slice(start, start + 6).join(' ');
        disabled = /Chain\.ZCASH\b/.test(block.slice(0, block.indexOf(')') + 1 || undefined));
      }
      gate3 = { commitSha: gsha, file: GATE3_FILE, zcashDisabled: disabled, line: start === -1 ? null : start + 1, url: `https://github.com/brave/gate3/blob/${gsha}/${GATE3_FILE}${start === -1 ? '' : `#L${start + 1}`}`, checkedAt: ctx.now };
      if (start === -1) limitations.push('SWAP_DISABLED_CHAINS not found in gate3 constants (routing switch moved?)');
    }

    // brave-variations studies mentioning Zcash.
    const vsha = await ctx.gh.commitSha('brave/brave-variations', 'main');
    const studies: StudyInfo[] = [];
    if (vsha) {
      const { data: listing } = await ctx.gh.rest<any[]>(`/repos/brave/brave-variations/contents/studies?ref=${vsha}`);
      const builds = new Map<string, string>();
      const rel = ctx.get<ReleasesData>('brave-releases')?.data;
      for (const l of rel?.latest ?? []) {
        const r = rel?.releases.find((x) => x.tag === l.tag);
        if (r?.chromium) builds.set(`${r.chromium.split('.')[0]}.${r.version}`, `${l.channel} ${r.version}`);
      }
      for (const f of listing.filter((x) => /\.json5?$/.test(x.name))) {
        if (!/zcash|wallet/i.test(f.name)) continue;
        const raw = await ctx.http.request(`https://raw.githubusercontent.com/brave/brave-variations/${vsha}/studies/${f.name}`, { scope: 'raw.githubusercontent.com' });
        const text = await raw.text();
        if (!/zcash/i.test(text)) continue;
        let parsed: any[];
        try {
          parsed = json5ToJson(text) as any[];
        } catch (err) {
          limitations.push(`could not parse ${f.name}: ${(err as Error).message.slice(0, 80)}`);
          continue;
        }
        for (const st of parsed) {
          const exps: any[] = st.experiment ?? [];
          const active = exps.filter((e) => (e.probability_weight ?? 0) > 0);
          const enable = active.flatMap((e) => e.feature_association?.enable_feature ?? []);
          const disable = active.flatMap((e) => e.feature_association?.disable_feature ?? []);
          const params: Record<string, string> = {};
          for (const e of active) for (const p of e.param ?? []) params[p.name] = String(p.value);
          if (![...enable, ...disable, ...Object.keys(params)].some((x) => /zcash|ironwood|wallet/i.test(x))) continue;
          const minVersion = st.filter?.min_version ?? null;
          const maxVersion = st.filter?.max_version ?? null;
          studies.push({
            file: f.name,
            name: st.name,
            features: { enable, disable },
            params,
            minVersion,
            maxVersion,
            channels: st.filter?.channel ?? [],
            platforms: st.filter?.platform ?? [],
            probability: active.reduce((n, e) => n + (e.probability_weight ?? 0), 0) || null,
            appliesTo: [...builds].map(([full, label]) => ({ build: `${label} (${full})`, applies: inStudyRange(full, minVersion, maxVersion) })),
            url: `https://github.com/brave/brave-variations/blob/${vsha}/studies/${f.name}`,
          });
        }
      }
    } else limitations.push('brave/brave-variations main not reachable');
    return { data: { gate3, studies, studiesCommit: vsha }, limitations, itemCount: studies.length + (gate3 ? 1 : 0) };
  },
};

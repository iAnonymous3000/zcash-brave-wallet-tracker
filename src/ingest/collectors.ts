import type { Collector } from './framework.ts';
import { releases } from './sources/releases.ts';
import { braveVersions } from './sources/brave-versions.ts';
import { githubItems } from './sources/github-items.ts';
import { changelogs } from './sources/changelogs.ts';
import { buildInclusion } from './sources/build-inclusion.ts';
import { flags } from './sources/flags.ts';
import { braveDeps } from './sources/deps.ts';
import { upstream, advisories } from './sources/upstream.ts';
import { community } from './sources/community.ts';
import { docs } from './sources/docs.ts';
import { watch } from './sources/watch.ts';
import { services } from './sources/services.ts';

/** Run order matters: later collectors read earlier ones via ctx.get(). */
export const COLLECTORS: Collector<any>[] = [
  releases,
  braveVersions,
  githubItems,
  changelogs,
  buildInclusion,
  flags,
  braveDeps,
  upstream,
  advisories,
  watch,
  services,
  community,
  docs,
];

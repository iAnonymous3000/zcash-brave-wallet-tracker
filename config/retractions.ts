// Change events withdrawn because they were produced by a tracker defect or a tracker rule change,
// not by a change in any source. Listed here (rather than deleted silently) so the correction is auditable.

export const RETRACTED_EVENTS: Record<string, string> = {
  // 2026-10-08 run 37795231929: new collectors / fixed source checks were diffed against the previous
  // run's output and reported as capability changes. The gate3 switch itself dates from brave/gate3#335 (2026-09-03).
  '0d35329ee997e12a': 'tracker change (gate3 collector added), not a source change',
  '1a9bf184e8075973': 'tracker change (gate3 collector added), not a source change',
  '68fd7ca7082909df': 'tracker change (gate3 collector added), not a source change',
  '6aa2ba09b93f7965': 'tracker change (gate3 collector added), not a source change',
  '6d2780f1ef2bb045': 'tracker change (gate3 collector added), not a source change',
  '9971d3b1281041a1': 'tracker change (gate3 collector added), not a source change',
  '84d70f61d8f0d124': 'tracker defect (source check read only the first candidate file)',
  'c8dacff4cde7a57a': 'tracker defect (source check read only the first candidate file)',
  'c9c413d9c5d0a703': 'tracker defect (line was still upstream; it had only left the tracked subset)',
  // Ancestry backlog resolving "unknown" to "included" for PRs merged long ago is not a new build inclusion.
  '00d1a85d8f92034b': 'ancestry backlog resolution, not a new build inclusion',
  '37cb428244ccf050': 'ancestry backlog resolution, not a new build inclusion',
  'a047fb40f734786a': 'ancestry backlog resolution, not a new build inclusion',
  'ca731b9a47210da0': 'ancestry backlog resolution, not a new build inclusion',
  '57111d5cebb39f46': 'ancestry backlog resolution, not a new build inclusion',
  '5fb314fe55dfbada': 'ancestry backlog resolution, not a new build inclusion',
  '69cf94e08baf1b38': 'ancestry backlog resolution, not a new build inclusion',
  '849f5c2ceeffed97': 'ancestry backlog resolution, not a new build inclusion',
  'd444a065bd4e1879': 'ancestry backlog resolution, not a new build inclusion',
  'f4d7b64d8b6d93c6': 'ancestry backlog resolution, not a new build inclusion',
  '8103f1e261fab6f6': 'ancestry backlog resolution, not a new build inclusion',
  'f668da7d3ed24c0f': 'ancestry backlog resolution, not a new build inclusion',
  '06915954626935ad': 'ancestry backlog resolution, not a new build inclusion',
  'b1737c45cbdf31e1': 'ancestry backlog resolution, not a new build inclusion',
  '2c7a61b921900367': 'ancestry backlog resolution, not a new build inclusion',
  '7ade0f91ab02864b': 'ancestry backlog resolution, not a new build inclusion',
};

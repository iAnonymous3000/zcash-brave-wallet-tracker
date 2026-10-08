// Topic classification: ordered, deterministic keyword rules over a group's titles
// and labels. The first matching rule wins; children of an epic inherit its topic.
// Grouping was chosen from the real inventory (see Coverage page).

export interface TopicRule {
  id: string;
  name: string;
  description: string;
  match: RegExp;
}

export const TOPICS: TopicRule[] = [
  {
    id: 'ironwood',
    name: 'Ironwood pool & migration',
    description: 'NU6.3 Ironwood shielded pool: v6 transactions, Ironwood scanning/balances, Orchard → Ironwood migration and its UI.',
    match: /\bironwood\b|\bnu6\.3\b|\bv6\b.*(transaction|serial)|orchard\s*(->|→|to)\s*ironwood|\bmigrat/i,
  },
  {
    id: 'security',
    name: 'Security & hardening',
    description: 'Security reviews, hardening, crash-on-invalid-input protections, advisories.',
    match: /\bsecurity\b|\bharden|\bvulnerab|\bcve-|\bghsa-|\bcrash\b|\bcheck\b.*\bfail|\bsanitiz|\bvalidat/i,
  },
  {
    id: 'shielded',
    name: 'Shielded (Orchard) support',
    description: 'Shielded accounts, shielding and unshielding (deshielding), Orchard notes and proofs.',
    match: /\bshield|\borchard\b|\bdeshield|\bunshield|\bproof|\bhalo2/i,
  },
  {
    id: 'sync',
    name: 'Sync, scanning & storage',
    description: 'Block scanning, chain sync state, account birthday, commitment trees, storage/database, lightwalletd endpoints.',
    match: /\bsync|\bscan|\bblock(s)?\b|\bbirthday|\bchain ?tip|\bwitness|\bshardtree|\btree\b|\bdatabase|\bstorage|\breorg|\blightwalletd|\bgrpc|\bendpoint|\bproxy|\brpc\b/i,
  },
  {
    id: 'transactions',
    name: 'Transactions & fees',
    description: 'Creating, signing and broadcasting ZEC transactions; ZIP-317 fees; amounts and UTXOs.',
    match: /\bfee|\bzip[- ]?317|\bsend\b|\btransaction|\btx\b|\butxo|\bbroadcast|\bamount|\bchange address|\bconfirm/i,
  },
  {
    id: 'addresses',
    name: 'Addresses, accounts & memos',
    description: 'Unified/transparent/shielded addresses, account creation and recovery, memos.',
    match: /\baddress|\bmemo|\bunified|\bzip[- ]?316|\bzip[- ]?302|\baccount|\bkeyring|\bseed|\brecover|\brestore|\bimport\b|\bexport\b|\bderiv/i,
  },
  {
    id: 'swaps',
    name: 'Swaps, bridge & on-ramps',
    description: 'ZEC swaps and bridging (e.g. NEAR Intents), buy/on-ramp providers.',
    match: /\bswap|\bbridge|\bnear intents|\bonramp|\bon-ramp|\bbuy\b|\bramp\b/i,
  },
  {
    id: 'display',
    name: 'Balances, pricing & display',
    description: 'Balances, token lists, pricing and currency settings, UI display.',
    match: /\bbalance|\bprice|\bcurrency|\bfiat|\bportfolio|\btoken\b|\bdisplay|\bicon|\bui\b|\bdark (mode|theme)/i,
  },
  {
    id: 'deps',
    name: 'Dependencies & Rust crates',
    description: 'Updates to orchard, librustzcash and other Rust crates Brave builds.',
    match: /\bcrate|\blibrustzcash|\bcargo|\bupdate .* (library|lib)\b|\bbump\b|\brust\b|\bzcash_[a-z_]+/i,
  },
  {
    id: 'testing',
    name: 'Testnet, tests & tooling',
    description: 'Zcash testnet support, unit/browser tests, CI and developer tooling.',
    match: /\btestnet|\btest(s|ing)?\b|\bflaky|\bci\b|\bunittest|\bbrowsertest/i,
  },
];

export const FALLBACK_TOPIC = { id: 'general', name: 'General Zcash support', description: 'Zcash work that does not fit a narrower topic (feature flags, enablement, profiles, settings).' };

/** Mobile is a facet (OS labels) rather than a topic, but mobile-only work is flagged. */
export const MOBILE_HINT = /\bandroid\b|\bios\b|\biphone\b|\bipad\b|\bmobile\b/i;

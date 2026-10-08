// Tracker configuration: what is monitored and how relevance is decided.
// Changing this file changes coverage; every rule here is documented on the
// Coverage page of the site.

export const SITE = {
  title: 'Zcash × Brave Wallet Tracker',
  repoUrl: 'https://github.com/iAnonymous3000/zcash-brave-wallet-tracker',
  /** Base path for GitHub Pages project sites. Overridable with TRACKER_BASE_PATH. */
  basePath: process.env.TRACKER_BASE_PATH ?? '/zcash-brave-wallet-tracker/',
  /** Expected refresh cadence (must match .github/workflows/refresh.yml). */
  refreshEveryMinutes: 120,
};

export const REPOS = {
  browser: 'brave/brave-browser',
  core: 'brave/brave-core',
} as const;

/** Repos whose items may be tracked (issues/PRs elsewhere are recorded as external refs only). */
export const TRACKED_REPOS: string[] = [REPOS.browser, REPOS.core, 'brave/gate3', 'brave/brave-variations'];

/** Repos whose merged changes take effect on Brave's servers, not in a browser build. */
export const SERVICE_REPOS = new Set(['brave/gate3', 'brave/brave-variations']);

/**
 * Only references to these public repositories (or public upstream orgs) are stored.
 * Anything else (e.g. private brave/internal or brave/reviews links visible to an
 * org member's token) is dropped entirely so private identifiers never reach the site.
 */
export const PUBLIC_REF_REPOS = new Set(['brave/brave-browser', 'brave/brave-core', 'brave/brave-variations', 'brave/brave-ios']);
export const PUBLIC_REF_OWNERS = new Set(['zcash', 'zingolabs', 'zcashfoundation', 'zakura-core']);

export function isPublicRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const repo = ref.slice(0, ref.lastIndexOf('#')).toLowerCase();
  return PUBLIC_REF_REPOS.has(repo) || PUBLIC_REF_OWNERS.has(repo.split('/')[0]);
}

/** Labels that mark Zcash work. Labels alone are insufficient (e.g. #56872 lacks it). */
export const ZCASH_LABELS: Record<string, string[]> = {
  [REPOS.browser]: ['feature/web3/wallet/zcash'],
  // brave-core has no Zcash label; its PRs are found by keyword search, code paths and issue links.
};

/** Keyword searches (GitHub issue/PR search, fully paginated, window-split above 1000 hits). */
export const SEARCHES: { repo: string; q: string }[] = [
  { repo: REPOS.browser, q: 'zcash' },
  { repo: REPOS.browser, q: 'zec' },
  { repo: REPOS.browser, q: 'ironwood' },
  { repo: REPOS.browser, q: 'orchard wallet' },
  { repo: REPOS.browser, q: 'lightwalletd' },
  { repo: REPOS.browser, q: 'shielded wallet' },
  { repo: REPOS.core, q: 'zcash is:pr' },
  { repo: REPOS.core, q: 'zec is:pr' },
  { repo: REPOS.core, q: 'ironwood is:pr' },
  { repo: REPOS.core, q: 'orchard is:pr' },
  { repo: REPOS.core, q: 'lightwalletd is:pr' },
  { repo: REPOS.core, q: 'shielded is:pr' },
  // Server-side: swap routing backend and field-trial configs.
  { repo: 'brave/gate3', q: 'zcash' },
  { repo: 'brave/brave-variations', q: 'zcash' },
];

/** brave-core paths whose commit history identifies Zcash implementation PRs. */
export const CODE_PATHS: string[] = [
  'components/brave_wallet/browser/zcash',
];

/** Vocabulary used to decide whether an item is about Zcash. */
export const VOCAB = {
  /** A match on any of these in title, labels or description makes an item directly relevant. */
  strong: /\b(z\s?cash\w*|s?zec|ironwood|lightwalletd|zaino|librustzcash)\b/i,
  /** These only count with Brave Wallet context (wallet label or the word "wallet"). */
  contextual: /\b(orchard|shielded|unshield(ed|ing)?|deshield(ing)?|unified address(es)?|sapling|zip[- ]?3\d\d)\b/i,
  walletContext: /\bwallet\b/i,
};

/** Brave's release-notes / verification meta issues: release evidence is read from changelogs instead. */
export const META_ISSUE_TITLE = /\brelease notes?\b|\bpending verification|\[changelog\]/i;

/** Wallet-context labels. */
export const WALLET_LABEL = /^feature\/web3\/wallet/i;

/** Linked items pulled in through relationships are capped to keep runs bounded. */
export const MAX_LINKED_ITEMS = 600;

/** Freshness thresholds used by the site (computed in the browser from stored timestamps). */
export const FRESHNESS = {
  /** A source is "stale" when its last success is older than this. */
  staleAfterMinutes: 6 * 60,
};

// Capability definitions for the platform × channel matrix.
// Each row names the evidence that can establish it. Rows were chosen from Brave's
// own release notes and source (see research notes in README "Decisions").
// Evidence is evaluated per platform and per channel; see src/derive/capabilities.ts.

import type { Platform } from '../src/lib/types.ts';

const bb = (n: number) => `brave/brave-browser#${n}`;

export interface SourceCheckDef {
  id: string;
  /** Candidate files (first one that exists at the tag is used). */
  files: string[];
  pattern: RegExp;
  describe: string;
}

export interface CapabilitySourceRef {
  id: string;
  describe: string;
  /** opt-in: presence means a brave://flags option exists; required: absence means not present;
   *  blocks: presence means the UI hides it on that platform; supports: informative evidence. */
  role: 'opt-in' | 'required' | 'blocks' | 'supports';
  platforms?: Platform[];
}

export interface CapabilityDef {
  id: string;
  name: string;
  description: string;
  releaseNoteIssues?: string[];
  releaseNoteMatch?: RegExp;
  releaseNoteExclude?: RegExp;
  flags?: { name: string; expect: boolean }[];
  sourceChecks?: CapabilitySourceRef[];
  implementedBy?: string[];
  notPlannedIssues?: string[];
  docMatch?: RegExp;
  /** Capability ids this one depends on; a cell is never shown as more available than its prerequisites. */
  requires?: string[];
  /** Server-side switch ids (see derive/index.ts) that can turn the capability off for everyone. */
  serviceChecks?: string[];
  /** Open tracked issues whose title matches are listed as known open issues for the row. */
  openIssueMatch?: RegExp;
  notes?: string[];
}

/** Files checked at each channel build's brave-core tag. */
export const SOURCE_CHECKS: SourceCheckDef[] = [
  { id: 'ironwood-option-desktop-android', files: ['browser/about_flags.cc'], pattern: /zcash_ironwood_enabled/, describe: 'brave://flags option to enable Ironwood (Desktop/Android flags UI)' },
  { id: 'ironwood-option-ios', files: ['ios/browser/flags/about_flags.mm'], pattern: /zcash_ironwood_enabled/, describe: 'brave://flags option to enable Ironwood (iOS flags UI)' },
  { id: 'zip317-constants', files: ['components/brave_wallet/common/zcash_utils.h'], pattern: /kMarginalFee\s*=\s*5000/, describe: 'ZIP-317 fee constants (kMarginalFee = 5000)' },
  { id: 'orchard-to-ironwood-task', files: ['components/brave_wallet/browser/zcash/zcash_create_orchard_to_ironwood_transaction_task.cc'], pattern: /OrchardToIronwood|orchard_to_ironwood|ZCashCreateOrchardToIronwood/i, describe: 'Orchard → Ironwood migration transaction task' },
  { id: 'meld-zec', files: ['components/brave_wallet/browser/meld_integration_service.cc', 'components/brave_wallet_ui/common/slices/endpoints/meld_integration.endpoints.ts'], pattern: /['",]ZEC['",]|,ZEC,/, describe: 'ZEC requested from the Meld buy/on-ramp aggregator' },
  { id: 'bridge-hidden-ios', files: ['components/brave_wallet_ui/page/screens/fungible_asset_details/fungible_asset_details.tsx'], pattern: /!isIOS\s*&&\s*isBridgeSupported/, describe: 'Bridge action hidden on iOS in the wallet UI' },
  { id: 'near-intents-zec', files: ['components/brave_wallet/browser/swap_service.cc'], pattern: /kZCashMainnet/, describe: 'NEAR Intents (gate3) supports the Zcash mainnet network' },
];

const ZEC = { name: 'kBraveWalletZCashFeature', expect: true };
const SHIELDED = { name: 'kZCashShieldedTransactionsEnabled', expect: true };
const IRONWOOD = { name: 'kZCashIronwoodEnabled', expect: true };

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'accounts',
    name: 'ZEC accounts (transparent send & receive)',
    description: 'Create Zcash accounts and send/receive transparent ZEC.',
    releaseNoteIssues: [bb(36613), bb(48171)],
    releaseNoteMatch: /enabled z\s?cash (support |feature flag )?by default/i,
    flags: [ZEC],
    docMatch: /zcash|zec/i,
  },
  {
    id: 'shielded',
    name: 'Shielded accounts & balances',
    description: 'Shielded (Orchard, now also Ironwood) accounts, balances and private sends.',
    releaseNoteIssues: [bb(44432)],
    releaseNoteMatch: /\bzcash shielded support\.?$|\bshielded account modal\b/i,
    flags: [ZEC, SHIELDED],
    implementedBy: [bb(44432)],
    docMatch: /shielded/i,
    openIssueMatch: /shield/i,
  },
  {
    id: 'shielding',
    requires: ['shielded'],
    name: 'Shield transparent funds',
    description: '"Shield Funds" / "Shield Account": move transparent ZEC into the shielded pool.',
    releaseNoteIssues: [bb(46596), bb(46598), bb(49621)],
    releaseNoteMatch: /\bshield funds\b|\bshield account\b|\bconfirm shield\b/i,
    flags: [ZEC, SHIELDED],
    implementedBy: [bb(46596)],
  },
  {
    id: 'unshielding',
    requires: ['shielded'],
    name: 'Unshield to transparent',
    description: 'Send from shielded balance to a transparent address (deshielding).',
    releaseNoteIssues: [bb(45875), bb(53718)],
    releaseNoteMatch: /\bunshield|\bdeshield/i,
    flags: [ZEC, SHIELDED],
    implementedBy: [bb(45875)],
  },
  {
    id: 'ironwood',
    requires: ['shielded'],
    name: 'Ironwood pool (NU6.3)',
    description: 'Ironwood shielded pool support: Ironwood balances, v6 transactions, sends to/from Ironwood.',
    releaseNoteIssues: [bb(56872)],
    releaseNoteMatch: /\bironwood support\b/i,
    releaseNoteExclude: /migration banner/i,
    flags: [ZEC, SHIELDED, IRONWOOD],
    sourceChecks: [
      { id: 'ironwood-option-desktop-android', describe: 'brave://flags Ironwood option', role: 'opt-in', platforms: ['desktop', 'android'] },
      { id: 'ironwood-option-ios', describe: 'brave://flags Ironwood option', role: 'opt-in', platforms: ['ios'] },
    ],
    implementedBy: [bb(56872)],
    openIssueMatch: /ironwood|nu6\.3/i,
    notes: [
      'Ironwood requires three compiled-in defaults to be on: Zcash, shielded transactions, and zcash_ironwood_enabled.',
      'The "Ironwood migration banner" (#58493) shipped in 1.95.101 before Ironwood was on by default, so it is not evidence of Ironwood availability.',
    ],
  },
  {
    id: 'migration',
    requires: ['ironwood'],
    name: 'Orchard → Ironwood migration',
    description: 'Move funds from the legacy Orchard pool into Ironwood (required after NU6.3 for new shielded value).',
    flags: [ZEC, SHIELDED, IRONWOOD],
    sourceChecks: [
      { id: 'orchard-to-ironwood-task', describe: 'Orchard → Ironwood transaction task', role: 'required' },
      { id: 'ironwood-option-desktop-android', describe: 'brave://flags Ironwood option', role: 'opt-in', platforms: ['desktop', 'android'] },
      { id: 'ironwood-option-ios', describe: 'brave://flags Ironwood option', role: 'opt-in', platforms: ['ios'] },
    ],
    implementedBy: [bb(58408)],
    openIssueMatch: /migrat|padding|zip[- ]?318/i,
    notes: ['No platform release note announces the migration flow itself; it ships as part of Ironwood support.'],
  },
  {
    id: 'memos',
    requires: ['shielded'],
    name: 'Memos on shielded sends',
    description: 'Attach a memo (up to 512 bytes) to shielded outputs.',
    releaseNoteIssues: [bb(41986), bb(42078), bb(52303)],
    releaseNoteMatch: /\bmemo\b/i,
    flags: [ZEC, SHIELDED],
    implementedBy: [bb(41986)],
    openIssueMatch: /memo/i,
  },
  {
    id: 'sync',
    requires: ['shielded'],
    name: 'Sync, birthday & recovery tools',
    description: 'Shielded sync status, reset sync state, account birthday reset/validation.',
    releaseNoteIssues: [bb(42851), bb(44782), bb(55611), bb(58757)],
    releaseNoteMatch: /\bsync state\b|\bout of sync\b|\baccount birthday\b|\bsync account\b/i,
    flags: [ZEC, SHIELDED],
    implementedBy: [bb(44782)],
    openIssueMatch: /sync|birthday|scan/i,
  },
  {
    id: 'addresses',
    name: 'Deposit addresses (unified, shielded, transparent)',
    description: 'Deposit screen with unified/shielded and transparent addresses.',
    releaseNoteIssues: [bb(42221), bb(45185), bb(49978), bb(41315)],
    releaseNoteMatch: /\bdeposit\b|\bunified address|\btransparent address/i,
    flags: [ZEC],
    implementedBy: [bb(45185)],
    openIssueMatch: /address|unified/i,
  },
  {
    id: 'fees',
    name: 'Automatic ZIP-317 fees',
    description: 'Fees computed by the ZIP-317 rule; no manual fee editing for Zcash.',
    releaseNoteIssues: [bb(45748)],
    releaseNoteMatch: /\bfees?\b|\bgas\b/i,
    flags: [ZEC],
    sourceChecks: [{ id: 'zip317-constants', describe: 'ZIP-317 constants', role: 'supports' }],
    openIssueMatch: /fee|zip[- ]?317/i,
  },
  {
    id: 'bridge',
    name: 'Cross-chain swaps / bridge (NEAR Intents)',
    description: 'Bridge ZEC to and from other chains through NEAR Intents. ZEC has no same-chain swap.',
    releaseNoteIssues: [bb(52555)],
    releaseNoteMatch: /\bbridge\b|\bnear intents\b/i,
    flags: [ZEC],
    sourceChecks: [
      { id: 'near-intents-zec', describe: 'NEAR Intents network list includes Zcash', role: 'supports' },
      { id: 'bridge-hidden-ios', describe: 'Bridge hidden on iOS', role: 'blocks', platforms: ['ios'] },
    ],
    implementedBy: [bb(52555)],
    serviceChecks: ['gate3-zcash-swaps'],
    openIssueMatch: /swap|bridge|near/i,
  },
  {
    id: 'buy',
    name: 'Buy ZEC (on-ramp via Meld)',
    description: 'Buy flow requests ZEC from Meld; which providers actually offer ZEC is decided by Meld at runtime.',
    flags: [ZEC],
    sourceChecks: [{ id: 'meld-zec', describe: 'Meld chain list includes ZEC', role: 'required' }],
    notes: ['Brave’s code requests ZEC quotes from Meld, but whether any provider returns them depends on Meld at runtime and is not publicly verifiable.'],
  },
  {
    id: 'testnet',
    name: 'Zcash testnet',
    description: 'Testnet accounts for development and testing.',
    releaseNoteIssues: [bb(50116)],
    releaseNoteMatch: /\btestnet\b/i,
    flags: [ZEC],
  },
  {
    id: 'default-currency',
    name: 'ZEC as default base currency',
    description: 'Selecting ZEC as the default base cryptocurrency in wallet settings.',
    notPlannedIssues: [bb(51665), bb(59532)],
    notes: ['Both requests were closed as not planned on 2026-09-30; Brave proposed removing the setting entirely (#59539).'],
  },
];

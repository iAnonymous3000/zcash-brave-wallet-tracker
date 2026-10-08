// Upstream Zcash components that Brave's source actually uses (verified against
// brave-core's chromium_crates_io/Cargo.lock, root DEPS and network_manager.cc).

export type Impact = 'high' | 'medium' | 'low';

export interface MonitoredCrate {
  crate: string;
  repo: string;
  impact: Impact;
  why: string;
}

export const CRATES: MonitoredCrate[] = [
  { crate: 'orchard', repo: 'zcash/orchard', impact: 'high', why: 'Orchard/Ironwood note encryption, bundles and proving (circuit feature) in Brave\'s zcash Rust crate' },
  { crate: 'zcash_primitives', repo: 'zcash/librustzcash', impact: 'high', why: 'Transaction components and merkle tree (built from Brave\'s librustzcash fork)' },
  { crate: 'zcash_protocol', repo: 'zcash/librustzcash', impact: 'high', why: 'Consensus/network constants (built from Brave\'s librustzcash fork)' },
  { crate: 'zcash_client_backend', repo: 'zcash/librustzcash', impact: 'high', why: 'Shardtree serialization (built from Brave\'s librustzcash fork)' },
  { crate: 'zcash_encoding', repo: 'zcash/librustzcash', impact: 'medium', why: 'Serialization helpers (built from Brave\'s librustzcash fork)' },
  { crate: 'zcash_note_encryption', repo: 'zcash/zcash_note_encryption', impact: 'high', why: 'Batch trial decryption used during scanning' },
  { crate: 'shardtree', repo: 'zcash/incrementalmerkletree', impact: 'high', why: 'Note commitment tree storage used by sync' },
  { crate: 'incrementalmerkletree', repo: 'zcash/incrementalmerkletree', impact: 'medium', why: 'Commitment tree primitives' },
  { crate: 'zip32', repo: 'zcash/zip32', impact: 'medium', why: 'HD key derivation (transitive via orchard)' },
  { crate: 'halo2_proofs', repo: 'zcash/halo2', impact: 'medium', why: 'Proving system (transitive via orchard circuit feature)' },
  { crate: 'halo2_gadgets', repo: 'zcash/halo2', impact: 'medium', why: 'Circuit gadgets (transitive; subject of CVE-2026-54496)' },
  { crate: 'pasta_curves', repo: 'zcash/pasta_curves', impact: 'low', why: 'Curve arithmetic (transitive)' },
  { crate: 'reddsa', repo: 'ZcashFoundation/reddsa', impact: 'low', why: 'Signatures (transitive)' },
  { crate: 'sinsemilla', repo: 'zcash/sinsemilla', impact: 'low', why: 'Hash (transitive)' },
];

/** GitHub-released components with a plausible Brave impact. */
export const RELEASE_REPOS: { repo: string; name: string; impact: Impact; why: string; mode: 'releases' | 'tags' }[] = [
  { repo: 'zcash/lightwalletd', name: 'lightwalletd', impact: 'high', why: 'Light-client server protocol Brave speaks (CompactTxStreamer over gRPC); Brave takes the consensus branch ID from GetLightdInfo', mode: 'releases' },
  { repo: 'zcash/lightwallet-protocol', name: 'lightwallet-protocol', impact: 'high', why: 'Canonical .proto definitions mirrored in Brave\'s zcash_grpc_data.proto', mode: 'tags' },
  { repo: 'zingolabs/zaino', name: 'Zaino', impact: 'medium', why: 'Alternative indexer implementing the same CompactTxStreamer API; no reference in brave-core', mode: 'releases' },
];

/** Advisory queries: GitHub global advisories by ecosystem + package. */
export const ADVISORY_QUERIES: { ecosystem: string; pkg: string }[] = [
  ...CRATES.map((c) => ({ ecosystem: 'rust', pkg: c.crate })),
  { ecosystem: 'go', pkg: 'github.com/zcash/lightwalletd' },
];

/** Repositories whose published repository security advisories are read directly (not all reach the global DB). */
export const ADVISORY_REPOS = ['zcash/lightwalletd', 'zingolabs/zaino', 'zcash/orchard', 'zcash/librustzcash', 'zcash/halo2', 'zcash/incrementalmerkletree', 'zcash/zcash_note_encryption'];

/** ZIPs that Brave implements or that govern wallet behaviour. */
export const ZIPS: { num: string; topic: string; file?: string }[] = [
  { num: '0317', topic: 'Proportional transfer fee mechanism (Brave hard-codes kMarginalFee/kGraceActionsCount)' },
  { num: '0302', topic: 'Standardized memo field format' },
  { num: '0316', topic: 'Unified addresses (implemented in Brave C++)' },
  { num: '0225', topic: 'Version 5 transaction format' },
  { num: '0229', topic: 'Version 6 transaction format (Ironwood)' },
  { num: '0258', topic: 'NU6.3 deployment (Ironwood activation)' },
  { num: '0318', topic: 'Orchard to Ironwood migration (wallet)' },
  { num: '0326', topic: 'NU6.3 consequences for wallets' },
  { num: '2005', topic: 'Ironwood quantum recoverability' },
  { num: '0259', topic: 'NU7 deployment (next network upgrade)' },
  { num: '2009', topic: 'Reduce marginal fee to 1000 zatoshis (updates ZIP 317)', file: 'zips/2009.md' },
];

export const BRAVE_LOCKFILE = 'third_party/rust/chromium_crates_io/Cargo.lock';
export const BRAVE_ZCASH_CARGO = 'components/brave_wallet/browser/zcash/rust/Cargo.toml';
export const BRAVE_DEPS_KEY = 'components/brave_wallet/browser/zcash/rust/librustzcash/src';
export const BRAVE_NETWORK_FILE = 'components/brave_wallet/browser/network_manager.cc';
export const BRAVE_PROTO_FILE = 'components/services/brave_wallet/public/proto/zcash_grpc_data.proto';

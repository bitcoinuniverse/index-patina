/**
 * The single import point for consensus.
 *
 * Every constant, every derivation, every validity rule and the state reducer
 * itself come from @bitcoinuniverse/patina. This file re-exports that surface so
 * the rest of the service has exactly one place to look, and so a reviewer can
 * confirm at a glance that no protocol rule is restated here.
 *
 * Nothing in this file decides anything. If a rule appears to be missing, it
 * belongs in the protocol package, not here.
 */

export type {
  Artifact,
  ArtifactStatus,
  BlockView,
  Carrier,
  ConfirmationStatus,
  Counters,
  DeploymentRecord,
  InputView,
  InvalidEvent,
  OutputView,
  PatinaEvent,
  PrevoutView,
  Ring,
  Snapshot,
  TxView,
  WindowState,
} from '@bitcoinuniverse/patina';

export type {
  ApplyResult,
  CommitLeafMode,
  CommitInput,
  DecodeResult,
  KeepEntry,
  KeepMarker,
  Marker,
  Network,
  ReasonCode,
  ReplayResult,
  ScanResult,
  SeedMarker,
  SeedResult,
  SeedValid,
  Tier,
} from '@bitcoinuniverse/patina';

export {
  // identity and marker grammar
  artifactId,
  attestationMessage,
  buildCommitLeafScript,
  buildCommitLeafScriptForMode,
  buildLegacyCommitLeafScript,
  buildMarkerScript,
  buildReducedDataCommitLeafScript,
  commitCommitment,
  decodeMarker,
  decodeScriptPubKey,
  encodeMarker,
  extractTapscript,
  isTaprootScriptPubKey,
  outpointKey,
  parseCommitLeafScript,
  parseCommitLeafScriptWithMode,
  parseOutpointKey,
  scanScriptPubKey,
  txidToWire,
  wireToTxid,
  // validity
  defaultSuccessorVout,
  findCommitInputs,
  isFounding,
  isOpReturnOutput,
  validateKeepEntry,
  validateSeed,
  // reducer
  applyBlock,
  initialState,
  replay,
  // roots
  artifactsRoot,
  eventLeaf,
  eventRoot,
  merkleRoot,
  stateRoot,
  // depth and tiers
  blocksToNextTier,
  depthAt,
  nextTier,
  tierByIndex,
  tierFor,
  // deployment
  DeploymentError,
  deploymentFor,
  loadDeployment,
  loadDeploymentFile,
  loadShippedDeployment,
  windowStateAt,
  // constants
  COMMIT_MIN_AGE,
  CONFIRMATIONS_FINAL,
  GRACE_LENGTH,
  MAX_KEEP_ENTRIES,
  MAX_TIER_INDEX,
  MIN_CARRIER_FOUNDING,
  MIN_CARRIER_OPEN,
  MIN_SUCCESSOR,
  NETWORKS,
  PROTOCOL_ID,
  PROTOCOL_NAME,
  PROTOCOL_SLUG,
  REASON_CODES,
  TIERS,
  WINDOW_LENGTH,
  isReasonCode,
} from '@bitcoinuniverse/patina';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Version of the consensus package this build links against. It is recorded on
 * every block row, so a database can always be traced to the rules that wrote
 * it and a rule change forces a reindex rather than a silent divergence.
 */
export const PROTOCOL_PACKAGE_VERSION: string = (
  require('@bitcoinuniverse/patina/package.json') as { version: string }
).version;

/** The parser version stamped on every block this build applies. */
export const PARSER_VERSION = `patina/${PROTOCOL_PACKAGE_VERSION}`;

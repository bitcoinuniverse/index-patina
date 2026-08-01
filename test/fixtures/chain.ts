/**
 * Synthetic regtest chain used by every test.
 *
 * The chain is served through OfflineRpcClient, so the tests drive the real
 * ingest path: rpc -> resolver -> BlockView -> applyBlock -> store. Nothing is
 * stubbed between the RPC boundary and the database.
 *
 * Transaction ids are deterministic labels rather than real double SHA-256
 * digests. Nothing in the indexer recomputes a txid from raw bytes, and the
 * protocol derives artifact ids from the txid it is given, so a stable label is
 * enough to make every fixture reproducible.
 */

import { createHash } from 'node:crypto';

import {
  buildCommitLeafScriptForMode,
  buildMarkerScript,
  commitCommitment,
  type CommitLeafMode,
  type DeploymentRecord,
} from '../../src/protocol.js';
import type { OfflineChain, RpcBlock, RpcTransaction, RpcVin, RpcVout } from '../../src/rpc.js';

export function label(text: string): string {
  return createHash('sha256').update(`patina-fixture/${text}`, 'utf8').digest('hex');
}

export function blockHash(branch: string, height: number): string {
  return label(`block/${branch}/${height}`);
}

function xonly(text: string): string {
  return label(`key/${text}`);
}

function salt(text: string): string {
  return label(`salt/${text}`).slice(0, 32);
}

export function p2trScript(keyHex: string): string {
  return `5120${keyHex}`;
}

export function p2wpkhScript(text: string): string {
  return `0014${label(`addr/${text}`).slice(0, 40)}`;
}

export function opReturnDataScript(text: string): string {
  const data = label(`data/${text}`).slice(0, 20);
  return `6a0a${data}`;
}

export interface OutSpec {
  readonly sats: number;
  readonly script: string;
}

export interface InSpec {
  readonly txid: string;
  readonly vout: number;
  readonly witness?: readonly string[];
}

function vin(spec: InSpec): RpcVin {
  return {
    txid: spec.txid,
    vout: spec.vout,
    scriptSig: { asm: '', hex: '' },
    txinwitness: spec.witness === undefined ? [] : [...spec.witness],
    sequence: 0xfffffffd,
  };
}

function vout(spec: OutSpec, n: number): RpcVout {
  return { value: spec.sats / 1e8, n, scriptPubKey: { hex: spec.script } };
}

export function makeTx(name: string, inputs: readonly InSpec[], outputs: readonly OutSpec[]): RpcTransaction {
  return {
    txid: label(`tx/${name}`),
    version: 2,
    locktime: 0,
    vin: inputs.map(vin),
    vout: outputs.map(vout),
  };
}

function coinbase(height: number, branch: string): RpcTransaction {
  return {
    txid: label(`coinbase/${branch}/${height}`),
    version: 2,
    locktime: 0,
    vin: [{ coinbase: `${height.toString(16)}`, sequence: 0xffffffff }],
    vout: [{ value: 50, n: 0, scriptPubKey: { hex: p2wpkhScript(`miner/${branch}/${height}`) } }],
  };
}

export function coinbaseOutpoint(height: number, branch = 'a'): InSpec {
  return { txid: label(`coinbase/${branch}/${height}`), vout: 0 };
}

/** Build the witness stack of a commit leaf reveal: signature, leaf, control block. */
export function commitWitness(
  claimantXOnly: string,
  saltHex: string,
  mode: CommitLeafMode = 'reduced-data envelope',
): string[] {
  const commitment = commitCommitment(claimantXOnly, saltHex).toString('hex');
  const leaf = buildCommitLeafScriptForMode(claimantXOnly, commitment, mode).toString('hex');
  const control = `c0${claimantXOnly}`;
  return ['00'.repeat(64), leaf, control];
}

export function seedMarkerScript(saltHex: string, carrierVout: number): string {
  return buildMarkerScript({ op: 'SEED', salt: saltHex, flags: 0, carrierVout }).toString('hex');
}

export function keepMarkerScript(entries: readonly { inputIndex: number; vout: number }[]): string {
  return buildMarkerScript({ op: 'KEEP', entries: entries.map((entry) => ({ ...entry })) }).toString('hex');
}

export class ChainBuilder {
  readonly blocks: RpcBlock[] = [];
  constructor(
    readonly branch = 'a',
    private readonly firstHeight = 190,
  ) {}

  push(height: number, txs: readonly RpcTransaction[]): RpcBlock {
    const previous = this.blocks.length === 0 ? blockHash(this.branch, height - 1) : this.blocks[this.blocks.length - 1].hash;
    const all = [coinbase(height, this.branch), ...txs];
    const block: RpcBlock = {
      hash: blockHash(this.branch, height),
      confirmations: 1,
      height,
      version: 0x20000000,
      merkleroot: label(`merkle/${this.branch}/${height}`),
      time: 1700000000 + height * 600,
      nonce: height,
      bits: '207fffff',
      difficulty: 1,
      nTx: all.length,
      previousblockhash: previous,
      tx: all,
    };
    this.blocks.push(block);
    return block;
  }

  /** Fill every height from the last one written up to `height` with empty blocks. */
  fillTo(height: number): void {
    let next = this.blocks.length === 0 ? this.firstHeight : this.blocks[this.blocks.length - 1].height + 1;
    while (next <= height) {
      this.push(next, []);
      next += 1;
    }
  }

  at(height: number, txs: readonly RpcTransaction[]): RpcBlock {
    this.fillTo(height - 1);
    return this.push(height, txs);
  }

  tipHeight(): number {
    return this.blocks.length === 0 ? this.firstHeight - 1 : this.blocks[this.blocks.length - 1].height;
  }
}

export interface LifecycleChain {
  readonly chain: OfflineChain;
  readonly startHeight: number;
  readonly heights: {
    readonly commits: number;
    readonly seedFounding: number;
    readonly seedBundlePartner: number;
    readonly seedRelic: number;
    readonly seedBelowMin: number;
    readonly bundle: number;
    readonly keep: number;
    readonly relic: number;
    readonly defaultRule: number;
    readonly keepNoCarrier: number;
    readonly duplicateMarker: number;
    readonly tip: number;
  };
  readonly txids: Record<string, string>;
  readonly carrierAddressScript: string;
}

/**
 * A chain that walks one artifact through every state the protocol defines and
 * records one example of each invalid event the indexer is expected to store.
 */
export function buildLifecycleChain(
  deployment: DeploymentRecord,
  options: { readonly commitLeafMode?: CommitLeafMode } = {},
): LifecycleChain {
  const hOpen = deployment.hOpen as number;
  const minAge = deployment.commitMinAge;

  const commitHeight = hOpen;
  const seedFounding = hOpen + minAge;
  const seedBundlePartner = seedFounding + 1;
  const seedRelic = seedFounding + 2;
  const seedBelowMin = seedFounding + 3;
  const bundleHeight = seedFounding + 10;
  const keepHeight = seedFounding + 20;
  const relicHeight = seedFounding + 30;
  const defaultRuleHeight = seedFounding + 40;
  const keepNoCarrierHeight = seedFounding + 50;
  const duplicateMarkerHeight = seedFounding + 51;
  const tip = seedFounding + 60;

  const builder = new ChainBuilder('a', 190);

  const keyA = xonly('A');
  const keyB = xonly('B');
  const keyD = xonly('D');
  const keyE = xonly('E');
  const saltA = salt('A');
  const saltB = salt('B');
  const saltD = salt('D');
  const saltE = salt('E');
  const commitLeafMode = options.commitLeafMode ?? 'reduced-data envelope';

  const commitA = makeTx('commit-a', [coinbaseOutpoint(190)], [{ sats: 200000, script: p2trScript(keyA) }]);
  const commitB = makeTx('commit-b', [coinbaseOutpoint(191)], [{ sats: 200000, script: p2trScript(keyB) }]);
  const commitD = makeTx('commit-d', [coinbaseOutpoint(192)], [{ sats: 200000, script: p2trScript(keyD) }]);
  const commitE = makeTx('commit-e', [coinbaseOutpoint(193)], [{ sats: 200000, script: p2trScript(keyE) }]);
  builder.at(commitHeight, [commitA, commitB, commitD, commitE]);

  const seedA = makeTx(
    'seed-a',
    [{ txid: commitA.txid, vout: 0, witness: commitWitness(keyA, saltA, commitLeafMode) }],
    [
      { sats: 150000, script: p2wpkhScript('carrier-a') },
      { sats: 0, script: seedMarkerScript(saltA, 0) },
    ],
  );
  builder.at(seedFounding, [seedA]);

  const seedB = makeTx(
    'seed-b',
    [{ txid: commitB.txid, vout: 0, witness: commitWitness(keyB, saltB, commitLeafMode) }],
    [
      { sats: 120000, script: p2wpkhScript('carrier-b') },
      { sats: 0, script: seedMarkerScript(saltB, 0) },
    ],
  );
  builder.at(seedBundlePartner, [seedB]);

  const seedD = makeTx(
    'seed-d',
    [{ txid: commitD.txid, vout: 0, witness: commitWitness(keyD, saltD, commitLeafMode) }],
    [
      { sats: 110000, script: p2wpkhScript('carrier-d') },
      { sats: 0, script: seedMarkerScript(saltD, 0) },
    ],
  );
  builder.at(seedRelic, [seedD]);

  // Founding minimum is 100000 satoshis. This carrier holds less, so the SEED
  // is rejected with SEED_CARRIER_BELOW_MIN and creates nothing.
  const seedE = makeTx(
    'seed-e',
    [{ txid: commitE.txid, vout: 0, witness: commitWitness(keyE, saltE, commitLeafMode) }],
    [
      { sats: 50000, script: p2wpkhScript('carrier-e') },
      { sats: 0, script: seedMarkerScript(saltE, 0) },
    ],
  );
  builder.at(seedBelowMin, [seedE]);

  // Two carriers spent by one transaction with no marker. The default rule
  // routes both artifacts to the same output, which is a bundle.
  const bundle = makeTx(
    'bundle',
    [
      { txid: seedA.txid, vout: 0 },
      { txid: seedB.txid, vout: 0 },
    ],
    [{ sats: 260000, script: p2wpkhScript('carrier-bundle') }],
  );
  builder.at(bundleHeight, [bundle]);

  // KEEP names output 1, so the bundle skips the lower indexed output that the
  // default rule would otherwise have chosen.
  const keep = makeTx(
    'keep',
    [{ txid: bundle.txid, vout: 0 }],
    [
      { sats: 50000, script: p2wpkhScript('carrier-keep-decoy') },
      { sats: 190000, script: p2wpkhScript('carrier-keep') },
      { sats: 0, script: keepMarkerScript([{ inputIndex: 0, vout: 1 }]) },
    ],
  );
  builder.at(keepHeight, [keep]);

  // No output clears MIN_SUCCESSOR, so the artifact becomes a relic.
  const relic = makeTx(
    'relic',
    [{ txid: seedD.txid, vout: 0 }],
    [
      { sats: 0, script: opReturnDataScript('relic') },
      { sats: 5000, script: p2wpkhScript('dust') },
    ],
  );
  builder.at(relicHeight, [relic]);

  // Default rule again, this time stepping over an OP_RETURN at index 0.
  const defaultRule = makeTx(
    'default-rule',
    [{ txid: keep.txid, vout: 1 }],
    [
      { sats: 0, script: opReturnDataScript('note') },
      { sats: 180000, script: p2wpkhScript('carrier-default') },
    ],
  );
  builder.at(defaultRuleHeight, [defaultRule]);

  // A KEEP marker in a transaction that spends no carrier.
  const keepNoCarrier = makeTx(
    'keep-no-carrier',
    [coinbaseOutpoint(194)],
    [
      { sats: 40000, script: p2wpkhScript('unrelated') },
      { sats: 0, script: keepMarkerScript([{ inputIndex: 0, vout: 0 }]) },
    ],
  );
  builder.at(keepNoCarrierHeight, [keepNoCarrier]);

  // Two PTNA payloads in one transaction void the marker.
  const duplicateMarker = makeTx(
    'duplicate-marker',
    [coinbaseOutpoint(195)],
    [
      { sats: 0, script: seedMarkerScript(saltA, 0) },
      { sats: 0, script: seedMarkerScript(saltB, 0) },
      { sats: 40000, script: p2wpkhScript('unrelated-two') },
    ],
  );
  builder.at(duplicateMarkerHeight, [duplicateMarker]);

  builder.fillTo(tip);

  return {
    chain: { chain: 'regtest', blocks: builder.blocks },
    startHeight: 190,
    heights: {
      commits: commitHeight,
      seedFounding,
      seedBundlePartner,
      seedRelic,
      seedBelowMin,
      bundle: bundleHeight,
      keep: keepHeight,
      relic: relicHeight,
      defaultRule: defaultRuleHeight,
      keepNoCarrier: keepNoCarrierHeight,
      duplicateMarker: duplicateMarkerHeight,
      tip,
    },
    txids: {
      commitA: commitA.txid,
      commitB: commitB.txid,
      commitD: commitD.txid,
      commitE: commitE.txid,
      seedA: seedA.txid,
      seedB: seedB.txid,
      seedD: seedD.txid,
      seedE: seedE.txid,
      bundle: bundle.txid,
      keep: keep.txid,
      relic: relic.txid,
      defaultRule: defaultRule.txid,
    },
    carrierAddressScript: p2wpkhScript('carrier-default'),
  };
}

/** Extend a chain with a competing branch from `forkHeight + 1`. */
export function buildReorgBranch(
  base: LifecycleChain,
  forkHeight: number,
  blocks: number,
  branch = 'b',
): RpcBlock[] {
  const builder = new ChainBuilder(branch, forkHeight + 1);
  const parent = base.chain.blocks.find((block) => block.height === forkHeight);
  if (parent === undefined) throw new Error(`fork height ${forkHeight} is not in the base chain`);
  const out: RpcBlock[] = [];
  for (let i = 0; i < blocks; i += 1) {
    const height = forkHeight + 1 + i;
    const block = builder.push(height, []);
    const fixed: RpcBlock = { ...block, previousblockhash: i === 0 ? parent.hash : out[i - 1].hash };
    out.push(fixed);
  }
  return out;
}

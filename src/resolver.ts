/**
 * Block resolution.
 *
 * The resolver is the only place in the ingest path that touches the network.
 * It turns Bitcoin Core's block JSON into a BlockView in which every input
 * already carries its prevout value, its prevout scriptPubKey, the height the
 * prevout was created at, and the witness stack as revealed on chain.
 *
 * The creation height matters because a SEED reveal is only valid when the
 * commit output is at least COMMIT_MIN_AGE blocks old. The witness matters
 * because the commit leaf is revealed in the SEED spend.
 *
 * Once a BlockView exists the reducer needs nothing else, which is what makes
 * replay bit for bit reproducible.
 */

import type { BitcoinRpc, RpcBlock, RpcTransaction, RpcVin } from './rpc.js';
import type { BlockView, InputView, OutputView, TxView } from './protocol.js';

/** Convert a Bitcoin Core BTC amount to satoshis. */
export function btcToSats(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`not a BTC amount: ${value}`);
  const sats = Math.round(value * 1e8);
  if (!Number.isSafeInteger(sats)) throw new RangeError(`BTC amount out of range: ${value}`);
  return sats;
}

interface PrevoutRecord {
  readonly value: number;
  readonly scriptPubKey: string;
  readonly height: number;
}

class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export interface ResolvedBlock {
  readonly raw: RpcBlock;
  readonly view: BlockView;
}

export interface ResolverOptions {
  /** Maximum resolved prevouts held in memory. */
  readonly prevoutCacheSize?: number;
  /** Maximum block hash to height entries held in memory. */
  readonly heightCacheSize?: number;
  /** Called after each RPC call so the caller can count it. */
  readonly onRpcCall?: (failed: boolean) => void;
}

export class Resolver {
  private readonly prevouts: BoundedMap<string, PrevoutRecord>;
  private readonly heightByBlockHash: BoundedMap<string, number>;
  private readonly txBlockHash = new Map<string, string>();
  private readonly onRpcCall: (failed: boolean) => void;

  constructor(
    private readonly rpc: BitcoinRpc,
    options: ResolverOptions = {},
  ) {
    this.prevouts = new BoundedMap(options.prevoutCacheSize ?? 200000);
    this.heightByBlockHash = new BoundedMap(options.heightCacheSize ?? 20000);
    this.onRpcCall = options.onRpcCall ?? (() => {});
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const value = await fn();
      this.onRpcCall(false);
      return value;
    } catch (error) {
      this.onRpcCall(true);
      throw error;
    }
  }

  /** Remember the outputs of a block so inputs spending them resolve locally. */
  private memoizeBlockOutputs(block: RpcBlock): void {
    this.heightByBlockHash.set(block.hash, block.height);
    for (const tx of block.tx) {
      this.txBlockHash.set(tx.txid, block.hash);
      for (const out of tx.vout) {
        this.prevouts.set(`${tx.txid}:${out.n}`, {
          value: btcToSats(out.value),
          scriptPubKey: out.scriptPubKey.hex.toLowerCase(),
          height: block.height,
        });
      }
    }
    if (this.txBlockHash.size > 500000) this.txBlockHash.clear();
  }

  private async heightOfBlock(hash: string): Promise<number> {
    const cached = this.heightByBlockHash.get(hash);
    if (cached !== undefined) return cached;
    const block = await this.call(() => this.rpc.getBlock(hash));
    this.heightByBlockHash.set(hash, block.height);
    return block.height;
  }

  private async resolvePrevout(vin: RpcVin, blockHeight: number): Promise<PrevoutRecord> {
    const txid = vin.txid as string;
    const vout = vin.vout as number;
    const key = `${txid}:${vout}`;

    const cached = this.prevouts.get(key);
    if (cached) return cached;

    // Core returns prevout data directly when the caller has it available.
    if (vin.prevout && typeof vin.prevout.height === 'number') {
      const record: PrevoutRecord = {
        value: btcToSats(vin.prevout.value),
        scriptPubKey: vin.prevout.scriptPubKey.hex.toLowerCase(),
        height: vin.prevout.height,
      };
      this.prevouts.set(key, record);
      return record;
    }

    const knownBlockHash = this.txBlockHash.get(txid);
    const source: RpcTransaction = await this.call(() =>
      knownBlockHash ? this.rpc.getRawTransaction(txid, knownBlockHash) : this.rpc.getRawTransaction(txid),
    );
    const out = source.vout.find((o) => o.n === vout);
    if (!out) {
      throw new Error(`prevout ${key} does not exist in transaction ${txid}`);
    }

    let height: number;
    if (source.blockhash) {
      height = await this.heightOfBlock(source.blockhash);
    } else if (typeof source.confirmations === 'number' && source.confirmations > 0) {
      height = blockHeight - source.confirmations + 1;
    } else {
      throw new Error(`prevout ${key} has no confirmed creation height, refusing to guess`);
    }

    const record: PrevoutRecord = {
      value: btcToSats(out.value),
      scriptPubKey: out.scriptPubKey.hex.toLowerCase(),
      height,
    };
    this.prevouts.set(key, record);
    return record;
  }

  /** Resolve one transaction against a known block height. */
  async resolveTransaction(tx: RpcTransaction, blockHeight: number): Promise<TxView> {
    const coinbase = tx.vin.length > 0 && (tx.vin[0] as RpcVin).coinbase !== undefined;
    const outputs: OutputView[] = tx.vout
      .slice()
      .sort((a, b) => a.n - b.n)
      .map((out) => ({ value: btcToSats(out.value), scriptPubKey: out.scriptPubKey.hex.toLowerCase() }));

    if (coinbase) {
      return { txid: tx.txid, inputs: [], outputs, coinbase: true };
    }

    const inputs: InputView[] = [];
    for (const vin of tx.vin) {
      if (vin.txid === undefined || vin.vout === undefined) {
        throw new Error(`non coinbase input in ${tx.txid} has no outpoint`);
      }
      const prevout = await this.resolvePrevout(vin, blockHeight);
      inputs.push({
        txid: vin.txid,
        vout: vin.vout,
        witness: (vin.txinwitness ?? []).map((item) => item.toLowerCase()),
        prevout,
      });
    }
    return { txid: tx.txid, inputs, outputs };
  }

  /** Resolve a whole block by hash. The raw block comes back with the view
   * because callers need the block time, which a BlockView does not carry. */
  async resolveBlockByHash(hash: string): Promise<ResolvedBlock> {
    const raw = await this.call(() => this.rpc.getBlock(hash));
    return { raw, view: await this.resolveRawBlock(raw) };
  }

  /** Resolve a whole block by height. */
  async resolveBlockByHeight(height: number): Promise<ResolvedBlock> {
    const hash = await this.call(() => this.rpc.getBlockHash(height));
    return this.resolveBlockByHash(hash);
  }

  /** Resolve a block already fetched from Core. */
  async resolveRawBlock(block: RpcBlock): Promise<BlockView> {
    this.memoizeBlockOutputs(block);
    const txs: TxView[] = [];
    for (const tx of block.tx) {
      txs.push(await this.resolveTransaction(tx, block.height));
    }
    const view: BlockView = {
      height: block.height,
      hash: block.hash,
      ...(block.previousblockhash ? { prevHash: block.previousblockhash } : {}),
      txs,
    };
    return view;
  }

  /** Resolve a mempool transaction. Heights of its prevouts still come from chain data. */
  async resolveMempoolTransaction(tx: RpcTransaction, tipHeight: number): Promise<TxView> {
    return this.resolveTransaction(tx, tipHeight + 1);
  }

  cacheSizes(): { prevouts: number; heights: number } {
    return { prevouts: this.prevouts.size, heights: this.heightByBlockHash.size };
  }
}

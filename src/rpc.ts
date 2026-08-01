/**
 * Bitcoin Core JSON-RPC client.
 *
 * Everything that talks to the network lives behind this interface. The
 * resolver takes a BitcoinRpc and produces a BlockView; the reducer never sees
 * an RPC handle. That split is what makes replay deterministic.
 *
 * Offline mode is a real mode, not a test hook. It answers every call from an
 * in memory chain supplied by the caller, so the API can serve an already
 * indexed database with no node attached and the test suite can run anywhere.
 */

import { readFileSync } from 'node:fs';
import type { RpcConfig } from './config.js';

export interface RpcScriptPubKey {
  asm?: string;
  hex: string;
  type?: string;
  address?: string;
  addresses?: string[];
  desc?: string;
}

export interface RpcVout {
  value: number;
  n: number;
  scriptPubKey: RpcScriptPubKey;
}

export interface RpcVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  scriptSig?: { asm: string; hex: string };
  txinwitness?: string[];
  sequence: number;
  /** Present when Core is built with -txindex and returns prevout data. */
  prevout?: { generated?: boolean; height?: number; value: number; scriptPubKey: RpcScriptPubKey };
}

export interface RpcTransaction {
  txid: string;
  hash?: string;
  version: number;
  size?: number;
  vsize?: number;
  weight?: number;
  locktime: number;
  vin: RpcVin[];
  vout: RpcVout[];
  hex?: string;
  blockhash?: string;
  confirmations?: number;
  blocktime?: number;
}

export interface RpcBlock {
  hash: string;
  confirmations: number;
  height: number;
  version: number;
  merkleroot: string;
  time: number;
  mediantime?: number;
  nonce: number;
  bits: string;
  difficulty: number;
  nTx: number;
  previousblockhash?: string;
  nextblockhash?: string;
  strippedsize?: number;
  size?: number;
  weight?: number;
  tx: RpcTransaction[];
}

export interface RpcBlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  initialblockdownload?: boolean;
  pruned?: boolean;
  verificationprogress?: number;
}

export interface RpcTxOut {
  bestblock: string;
  confirmations: number;
  value: number;
  scriptPubKey: RpcScriptPubKey;
  coinbase: boolean;
}

export interface RpcMempoolAcceptResult {
  txid: string;
  wtxid?: string;
  allowed: boolean;
  'reject-reason'?: string;
  vsize?: number;
  fees?: { base: number };
}

export interface BitcoinRpc {
  readonly offline: boolean;
  getBlockchainInfo(): Promise<RpcBlockchainInfo>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string): Promise<RpcBlock>;
  getRawTransaction(txid: string, blockhash?: string): Promise<RpcTransaction>;
  getTxOut(txid: string, vout: number, includeMempool?: boolean): Promise<RpcTxOut | null>;
  getRawMempool(): Promise<string[]>;
  getMempoolTransaction(txid: string): Promise<RpcTransaction | null>;
  testMempoolAccept(rawTxHex: string[]): Promise<RpcMempoolAcceptResult[]>;
}

export class RpcError extends Error {
  readonly code: number;
  readonly method: string;
  constructor(method: string, code: number, message: string) {
    super(`bitcoin rpc ${method} failed with code ${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
    this.method = method;
  }
}

export class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcUnavailableError';
  }
}

function authorizationHeader(config: RpcConfig): string {
  if (config.cookieFile) {
    const cookie = readFileSync(config.cookieFile, 'utf8').trim();
    return `Basic ${Buffer.from(cookie, 'utf8').toString('base64')}`;
  }
  return `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

/** JSON-RPC client over HTTP with bounded retries on transport failures. */
export class CoreRpcClient implements BitcoinRpc {
  readonly offline = false;
  private readonly config: RpcConfig;
  private nextId = 0;

  constructor(config: RpcConfig) {
    this.config = config;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '1.0', id: `patina-${this.nextId++}`, method, params });
    let lastTransportError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await fetch(this.config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: authorizationHeader(this.config),
          },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new RpcUnavailableError(`bitcoin rpc rejected the credentials with HTTP ${response.status}`);
        }
        let payload: { result?: T; error?: { code: number; message: string } };
        try {
          payload = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
        } catch {
          throw new RpcUnavailableError(`bitcoin rpc returned non JSON with HTTP ${response.status}`);
        }
        if (payload.error) {
          throw new RpcError(method, payload.error.code, payload.error.message);
        }
        return payload.result as T;
      } catch (error) {
        if (error instanceof RpcError) throw error;
        if (error instanceof RpcUnavailableError) throw error;
        lastTransportError = error as Error;
        if (attempt < this.config.maxRetries) {
          await sleep(Math.min(2000, 100 * 2 ** attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new RpcUnavailableError(
      `bitcoin rpc ${method} unreachable after ${this.config.maxRetries + 1} attempts: ${lastTransportError?.message ?? 'unknown'}`,
    );
  }

  getBlockchainInfo(): Promise<RpcBlockchainInfo> {
    return this.call<RpcBlockchainInfo>('getblockchaininfo');
  }

  getBlockHash(height: number): Promise<string> {
    return this.call<string>('getblockhash', [height]);
  }

  getBlock(hash: string): Promise<RpcBlock> {
    return this.call<RpcBlock>('getblock', [hash, 2]);
  }

  getRawTransaction(txid: string, blockhash?: string): Promise<RpcTransaction> {
    const params: unknown[] = blockhash ? [txid, true, blockhash] : [txid, true];
    return this.call<RpcTransaction>('getrawtransaction', params);
  }

  getTxOut(txid: string, vout: number, includeMempool = true): Promise<RpcTxOut | null> {
    return this.call<RpcTxOut | null>('gettxout', [txid, vout, includeMempool]);
  }

  getRawMempool(): Promise<string[]> {
    return this.call<string[]>('getrawmempool', [false]);
  }

  async getMempoolTransaction(txid: string): Promise<RpcTransaction | null> {
    try {
      return await this.call<RpcTransaction>('getrawtransaction', [txid, true]);
    } catch (error) {
      if (error instanceof RpcError) return null;
      throw error;
    }
  }

  testMempoolAccept(rawTxHex: string[]): Promise<RpcMempoolAcceptResult[]> {
    return this.call<RpcMempoolAcceptResult[]>('testmempoolaccept', [rawTxHex]);
  }
}

/** A chain the offline client answers from. Heights are array indexes into `blocks`. */
export interface OfflineChain {
  chain: string;
  blocks: RpcBlock[];
  mempool?: RpcTransaction[];
  /** Extra transactions reachable by getrawtransaction, for example commit funding txs. */
  extraTransactions?: RpcTransaction[];
}

/**
 * Offline client. Answers from an in memory chain. Used by the test suite and
 * by `serve` when an operator wants to expose an already indexed database
 * without a node attached.
 */
export class OfflineRpcClient implements BitcoinRpc {
  readonly offline = true;
  private chain: OfflineChain;

  constructor(chain: OfflineChain = { chain: 'regtest', blocks: [] }) {
    this.chain = chain;
  }

  setChain(chain: OfflineChain): void {
    this.chain = chain;
  }

  /** Keep every block at or below `height`, then append a competing branch. */
  reorgTo(height: number, replacement: RpcBlock[]): void {
    this.chain = {
      ...this.chain,
      blocks: [...this.chain.blocks.filter((block) => block.height <= height), ...replacement],
    };
  }

  setMempool(transactions: RpcTransaction[]): void {
    this.chain = { ...this.chain, mempool: transactions };
  }

  private tip(): RpcBlock | null {
    return this.chain.blocks.length === 0 ? null : (this.chain.blocks[this.chain.blocks.length - 1] as RpcBlock);
  }

  private allTransactions(): RpcTransaction[] {
    const out: RpcTransaction[] = [];
    for (const block of this.chain.blocks) out.push(...block.tx);
    for (const tx of this.chain.extraTransactions ?? []) out.push(tx);
    for (const tx of this.chain.mempool ?? []) out.push(tx);
    return out;
  }

  async getBlockchainInfo(): Promise<RpcBlockchainInfo> {
    const tip = this.tip();
    return {
      chain: this.chain.chain,
      blocks: tip ? tip.height : -1,
      headers: tip ? tip.height : -1,
      bestblockhash: tip ? tip.hash : '',
      initialblockdownload: false,
    };
  }

  async getBlockHash(height: number): Promise<string> {
    const block = this.chain.blocks.find((b) => b.height === height);
    if (!block) throw new RpcError('getblockhash', -8, 'Block height out of range');
    return block.hash;
  }

  async getBlock(hash: string): Promise<RpcBlock> {
    const block = this.chain.blocks.find((b) => b.hash === hash);
    if (!block) throw new RpcError('getblock', -5, 'Block not found');
    return block;
  }

  async getRawTransaction(txid: string): Promise<RpcTransaction> {
    // Mirror what Core returns with -txindex: a confirmed transaction carries
    // the hash of the block that holds it and its confirmation count, which is
    // how the resolver learns a prevout's creation height on a cold cache.
    for (const block of this.chain.blocks) {
      const found = block.tx.find((t) => t.txid === txid);
      if (found === undefined) continue;
      const tip = this.tip();
      return {
        ...found,
        blockhash: block.hash,
        blocktime: block.time,
        confirmations: tip === null ? 1 : tip.height - block.height + 1,
      };
    }
    const loose = [...(this.chain.extraTransactions ?? []), ...(this.chain.mempool ?? [])].find(
      (t) => t.txid === txid,
    );
    if (loose === undefined) throw new RpcError('getrawtransaction', -5, 'No such mempool or blockchain transaction');
    return loose;
  }

  async getTxOut(txid: string, vout: number): Promise<RpcTxOut | null> {
    const tx = this.allTransactions().find((t) => t.txid === txid);
    const out = tx?.vout.find((o) => o.n === vout);
    if (!tx || !out) return null;
    const spent = this.allTransactions().some((t) => t.vin.some((i) => i.txid === txid && i.vout === vout));
    if (spent) return null;
    const tip = this.tip();
    return {
      bestblock: tip ? tip.hash : '',
      confirmations: 1,
      value: out.value,
      scriptPubKey: out.scriptPubKey,
      coinbase: false,
    };
  }

  async getRawMempool(): Promise<string[]> {
    return (this.chain.mempool ?? []).map((t) => t.txid);
  }

  async getMempoolTransaction(txid: string): Promise<RpcTransaction | null> {
    return (this.chain.mempool ?? []).find((t) => t.txid === txid) ?? null;
  }

  async testMempoolAccept(rawTxHex: string[]): Promise<RpcMempoolAcceptResult[]> {
    return rawTxHex.map((hex) => ({
      txid: hex.slice(0, 64),
      allowed: false,
      'reject-reason': 'offline mode does not evaluate mempool acceptance',
    }));
  }
}

export function createRpcClient(config: RpcConfig, offlineChain?: OfflineChain): BitcoinRpc {
  if (config.offline) return new OfflineRpcClient(offlineChain);
  return new CoreRpcClient(config);
}

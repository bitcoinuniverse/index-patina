/**
 * The sync loop.
 *
 * The ingest path is deliberately short:
 *
 *   getblock -> resolver.resolveRawBlock -> BlockView -> applyBlock -> store
 *
 * The resolver is the only step that reaches the network. applyBlock comes
 * straight from the protocol package and is pure. The store writes one
 * transaction per block together with an undo document, so the database is
 * never between two blocks.
 *
 * A restart is safe because nothing is remembered outside the database. The
 * snapshot is rebuilt from the tables and checked against the state root the
 * reducer wrote for the tip. If those disagree the process refuses to serve.
 */

import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { BitcoinRpc } from './rpc.js';
import { Resolver, type ResolvedBlock } from './resolver.js';
import { Store, StoreError } from './store.js';
import { MempoolOverlay } from './mempool.js';
import { deriveBlockFacts } from './facts.js';
import {
  applyBlock,
  initialState,
  stateRoot,
  PARSER_VERSION,
  type BlockView,
  type Snapshot,
} from './protocol.js';

export interface IndexerOptions {
  readonly config: AppConfig;
  readonly store: Store;
  readonly rpc: BitcoinRpc;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly resolver?: Resolver;
}

export class ReorgTooDeepError extends Error {
  constructor(depth: number, limit: number) {
    super(`reorg of ${depth} blocks exceeds PATINA_MAX_REORG_DEPTH of ${limit}, refusing to roll back automatically`);
    this.name = 'ReorgTooDeepError';
  }
}

export interface SyncSummary {
  readonly applied: number;
  readonly rolledBack: number;
  readonly indexedHeight: number;
  readonly tipHeight: number;
  readonly caughtUp: boolean;
}

export class Indexer {
  readonly store: Store;
  readonly resolver: Resolver;
  readonly mempool: MempoolOverlay;

  private readonly config: AppConfig;
  private readonly rpc: BitcoinRpc;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  private snapshot: Snapshot = initialState();
  private tipHeight = -1;
  private running = false;
  private stopRequested = false;
  private loopDone: Promise<void> | null = null;

  constructor(options: IndexerOptions) {
    this.config = options.config;
    this.store = options.store;
    this.rpc = options.rpc;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.resolver =
      options.resolver ?? new Resolver(options.rpc, { onRpcCall: (failed) => options.metrics.recordRpcCall(failed) });
    this.mempool = new MempoolOverlay(this.store, this.rpc, this.resolver);
  }

  /** Migrate, bind and load the snapshot. Refuses to continue on a root mismatch. */
  open(): void {
    this.store.migrate();
    this.store.bind(PARSER_VERSION, this.config.deployment.specSha256, this.config.indexer.startHeight);
    this.snapshot = this.store.loadSnapshot();
    const tip = this.store.tipBlock();
    if (tip !== null) {
      const root = stateRoot(this.snapshot);
      if (root !== tip.state_root) {
        throw new StoreError(
          `state rebuilt from the database has root ${root} but block ${tip.height} recorded ${tip.state_root}. Run reindex.`,
        );
      }
    }
    this.logger.info('indexer opened', {
      network: this.config.network,
      indexedHeight: this.snapshot.height,
      artifacts: Object.keys(this.snapshot.artifacts).length,
      parserVersion: PARSER_VERSION,
    });
  }

  currentSnapshot(): Snapshot {
    return this.snapshot;
  }

  indexedHeight(): number {
    return this.store.indexedHeight();
  }

  knownTipHeight(): number {
    return this.tipHeight;
  }

  async refreshTip(): Promise<number> {
    const info = await this.rpc.getBlockchainInfo();
    this.metrics.recordRpcCall(false);
    this.tipHeight = info.blocks;
    return this.tipHeight;
  }

  /**
   * Apply one already resolved block. Exposed so tests and the reindex path can
   * drive the exact same code the sync loop uses.
   */
  applyResolvedBlock(view: BlockView, blockTime: number): void {
    const existing = this.store.getBlock(view.height);
    if (existing !== null) {
      if (existing.hash === view.hash) {
        this.logger.debug('block already applied, skipping', { height: view.height, hash: view.hash });
        return;
      }
      throw new StoreError(
        `height ${view.height} already holds block ${existing.hash}, refusing to overwrite with ${view.hash}`,
      );
    }

    const prior = this.snapshot;
    const priorRoot = stateRoot(prior);
    const applied = applyBlock(prior, view, this.config.deployment);
    const nextRoot = stateRoot(applied.state);
    const facts = deriveBlockFacts(view, prior, applied.events, applied.invalidEvents, this.config.deployment);

    this.store.applyBlock({
      view,
      prior,
      next: applied.state,
      events: applied.events,
      invalidEvents: applied.invalidEvents,
      facts,
      priorStateRoot: priorRoot,
      nextStateRoot: nextRoot,
      parserVersion: PARSER_VERSION,
      blockTime,
    });

    this.snapshot = applied.state;
    this.metrics.recordBlockApplied();

    if (view.height % this.config.indexer.checkpointInterval === 0) {
      this.store.writeCheckpoint(view.height, view.hash, nextRoot, applied.state.counters);
    }
    const retention = this.config.indexer.undoRetentionBlocks;
    if (view.height > retention) this.store.pruneUndo(view.height - retention);

    if (applied.events.length > 0 || applied.invalidEvents.length > 0) {
      this.logger.info('block applied', {
        height: view.height,
        hash: view.hash,
        events: applied.events.length,
        invalid: applied.invalidEvents.length,
        stateRoot: nextRoot,
      });
    }
  }

  private async fetchBlockAtHeight(height: number): Promise<ResolvedBlock> {
    return this.resolver.resolveBlockByHeight(height);
  }

  /**
   * Roll the database back to `targetHeight`, verifying after every step that
   * the rebuilt state matches the root recorded before that block was applied.
   */
  rollbackTo(targetHeight: number): number {
    let height = this.store.indexedHeight();
    let rolled = 0;
    while (height > targetHeight) {
      const expected = this.store.rollbackBlock(height);
      const rebuilt = this.store.loadSnapshot();
      const actual = stateRoot(rebuilt);
      if (actual !== expected) {
        throw new StoreError(
          `rollback of block ${height} produced state root ${actual} but the undo document recorded ${expected}`,
        );
      }
      this.snapshot = rebuilt;
      this.metrics.recordBlockRolledBack();
      rolled += 1;
      height = this.store.indexedHeight();
    }
    return rolled;
  }

  /**
   * Find the highest stored height whose hash the node still agrees with.
   * Returns -1 when nothing is stored.
   */
  private async findForkHeight(): Promise<number> {
    const indexed = this.store.indexedHeight();
    const floor = Math.max(this.store.firstIndexedHeight(), indexed - this.config.indexer.maxReorgDepth);
    for (let height = indexed; height >= floor && height >= 0; height -= 1) {
      const stored = this.store.getBlock(height);
      if (stored === null) continue;
      let canonicalHash: string;
      try {
        canonicalHash = await this.rpc.getBlockHash(height);
        this.metrics.recordRpcCall(false);
      } catch {
        this.metrics.recordRpcCall(true);
        continue;
      }
      if (canonicalHash === stored.hash) return height;
    }
    throw new ReorgTooDeepError(indexed - floor + 1, this.config.indexer.maxReorgDepth);
  }

  private async handleReorg(): Promise<number> {
    const oldTip = this.store.tipBlock();
    if (oldTip === null) return 0;
    const forkHeight = await this.findForkHeight();
    const depth = oldTip.height - forkHeight;
    this.logger.warn('reorg detected', { forkHeight, depth, oldTipHeight: oldTip.height, oldTipHash: oldTip.hash });

    const rolled = this.rollbackTo(forkHeight);
    const restoredRoot = stateRoot(this.snapshot);
    const forkBlock = this.store.getBlock(forkHeight);
    const verified = forkBlock === null ? this.snapshot.height === -1 : forkBlock.state_root === restoredRoot;

    this.store.recordReorg({
      forkHeight,
      depth,
      oldTipHeight: oldTip.height,
      oldTipHash: oldTip.hash,
      newTipHash: null,
      restoredStateRoot: restoredRoot,
      rootVerified: verified,
    });
    if (!verified) {
      throw new StoreError(
        `rollback to height ${forkHeight} left state root ${restoredRoot} which does not match the stored root`,
      );
    }
    this.logger.info('reorg rolled back', { forkHeight, rolled, restoredRoot });
    return rolled;
  }

  /**
   * Apply every block the node has that this database does not, handling a
   * reorg when the stored tip is no longer canonical.
   */
  async syncOnce(limit = Number.POSITIVE_INFINITY): Promise<SyncSummary> {
    const tip = await this.refreshTip();
    let rolledBack = 0;

    const stored = this.store.tipBlock();
    if (stored !== null) {
      let canonical: string | null = null;
      try {
        canonical = await this.rpc.getBlockHash(stored.height);
        this.metrics.recordRpcCall(false);
      } catch {
        this.metrics.recordRpcCall(true);
        canonical = null;
      }
      if (canonical === null || canonical !== stored.hash) {
        rolledBack = await this.handleReorg();
      }
    }

    let applied = 0;
    let next = this.store.indexedHeight() === -1 ? this.config.indexer.startHeight : this.store.indexedHeight() + 1;

    while (next <= tip && applied < limit && !this.stopRequested) {
      const { raw, view } = await this.fetchBlockAtHeight(next);
      const storedTip = this.store.tipBlock();
      if (storedTip !== null && view.prevHash !== undefined && view.prevHash !== storedTip.hash) {
        rolledBack += await this.handleReorg();
        next = this.store.indexedHeight() === -1 ? this.config.indexer.startHeight : this.store.indexedHeight() + 1;
        continue;
      }
      this.applyResolvedBlock(view, raw.time);
      if (this.config.indexer.mempoolEnabled) {
        this.mempool.confirm(view.txs.map((tx) => tx.txid));
      }
      applied += 1;
      next += 1;
    }

    const indexedHeight = this.store.indexedHeight();
    return { applied, rolledBack, indexedHeight, tipHeight: tip, caughtUp: indexedHeight >= tip };
  }

  /** Historical backfill followed by tip following. Returns when stop() is called. */
  async run(): Promise<void> {
    if (this.running) throw new Error('indexer is already running');
    this.running = true;
    this.stopRequested = false;

    const loop = async (): Promise<void> => {
      let mempoolDueAt = 0;
      while (!this.stopRequested) {
        try {
          const summary = await this.syncOnce();
          if (this.config.indexer.mempoolEnabled && Date.now() >= mempoolDueAt && summary.caughtUp) {
            try {
              const result = await this.mempool.refresh(this.snapshot, this.tipHeight);
              if (result.added > 0 || result.removed > 0) {
                this.logger.debug('mempool overlay refreshed', { ...result });
              }
            } catch (error) {
              this.logger.warn('mempool refresh failed', { error: error as Error });
            }
            mempoolDueAt = Date.now() + this.config.indexer.mempoolPollIntervalMs;
          }
          if (summary.caughtUp) await this.sleep(this.config.indexer.pollIntervalMs);
        } catch (error) {
          this.logger.error('sync pass failed', { error: error as Error });
          await this.sleep(this.config.indexer.pollIntervalMs);
        }
      }
      this.running = false;
    };

    this.loopDone = loop();
    await this.loopDone;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopDone !== null) await this.loopDone;
    this.loopDone = null;
  }

  /** Sleep, but wake up straight away when a shutdown has been requested. */
  private async sleep(ms: number): Promise<void> {
    const step = Math.min(100, ms);
    let waited = 0;
    while (waited < ms && !this.stopRequested) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, Math.min(step, ms - waited));
        timer.unref?.();
      });
      waited += step;
    }
  }

  /**
   * Replay from the first stored height and compare the recomputed state root
   * of every block with the root the database holds.
   */
  async verify(): Promise<{ checked: number; mismatches: { height: number; stored: string; recomputed: string }[] }> {
    const from = this.store.firstIndexedHeight();
    const to = this.store.indexedHeight();
    const mismatches: { height: number; stored: string; recomputed: string }[] = [];
    if (from < 0) return { checked: 0, mismatches };

    let state = initialState();
    let checked = 0;
    for (let height = from; height <= to; height += 1) {
      const storedBlock = this.store.getBlock(height);
      if (storedBlock === null) continue;
      const { view } = await this.resolver.resolveBlockByHash(storedBlock.hash);
      const applied = applyBlock(state, view, this.config.deployment);
      state = applied.state;
      const recomputed = stateRoot(state);
      checked += 1;
      if (recomputed !== storedBlock.state_root) {
        mismatches.push({ height, stored: storedBlock.state_root, recomputed });
      }
    }
    return { checked, mismatches };
  }

  /** Drop every derived row and start again from the configured start height. */
  reindex(): void {
    const run = this.store.db.transaction(() => {
      this.store.db.prepare('DELETE FROM blocks').run();
      this.store.db.prepare('DELETE FROM artifacts').run();
      this.store.db.prepare('DELETE FROM carriers').run();
      this.store.db.prepare('DELETE FROM commits').run();
      this.store.db.prepare('DELETE FROM checkpoints').run();
      this.store.db.prepare('DELETE FROM reorgs').run();
      this.store.db.prepare('DELETE FROM mempool_entries').run();
      this.store.db.prepare('DELETE FROM mempool_replacements').run();
      this.store.db.prepare('DELETE FROM mempool_conflicts').run();
    });
    run();
    this.snapshot = initialState();
    this.logger.warn('database cleared for reindex', { startHeight: this.config.indexer.startHeight });
  }

  /** Roll back to `from - 1` and re-apply forward to `to`, or to the tip. */
  async reindexRange(from: number, to: number | null): Promise<SyncSummary> {
    if (from <= this.store.indexedHeight()) {
      this.rollbackTo(from - 1);
    }
    const tip = await this.refreshTip();
    const target = to === null ? tip : Math.min(to, tip);
    let applied = 0;
    for (let height = Math.max(from, this.store.indexedHeight() + 1); height <= target; height += 1) {
      const { raw, view } = await this.fetchBlockAtHeight(height);
      this.applyResolvedBlock(view, raw.time);
      applied += 1;
    }
    const indexedHeight = this.store.indexedHeight();
    return { applied, rolledBack: 0, indexedHeight, tipHeight: tip, caughtUp: indexedHeight >= tip };
  }
}

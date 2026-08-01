/**
 * The read API.
 *
 * Every endpoint is a plain function from a request object to a response
 * object, so the test suite calls them directly with no socket involved. The
 * node:http adapter in http.ts is the only place a port appears.
 *
 * Serialization follows the baseline: satoshi values are decimal strings and
 * heights are numbers.
 */

import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { MempoolOverlay } from './mempool.js';
import type { ArtifactRow, CarrierRow, InvalidEventRow, RingRow, Store } from './store.js';
import { artifactFromRow, ringFromRow } from './store.js';
import { censusForEpoch, currentCensus, epochOf } from './census.js';
import { buildOpenApiDocument } from './openapi.js';
import {
  blocksToNextTier,
  depthAt,
  nextTier,
  outpointKey,
  parseOutpointKey,
  tierFor,
  windowStateAt,
  PARSER_VERSION,
  PROTOCOL_ID,
  REASON_CODES,
  TIERS,
} from './protocol.js';
import { INDEXER_VERSION } from './version.js';
import { buildPage, decodeCursor, sats, type Page } from './serialize.js';
import {
  HttpError,
  RateLimiter,
  Router,
  SECURITY_HEADERS,
  json,
  type ApiRequest,
  type ApiResponse,
  type HttpMethod,
} from './http.js';

export { INDEXER_VERSION } from './version.js';

export interface ApiDeps {
  readonly config: AppConfig;
  readonly store: Store;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly mempool?: MempoolOverlay;
  /** Chain tip as last seen from the node, or -1 when unknown. */
  tipHeight(): number;
}

// ------------------------------------------------------------------ helpers

function serializeRing(row: RingRow): unknown {
  return {
    index: row.ring_index,
    start_height: row.start_height,
    end_height: row.end_height,
    depth: row.depth,
    carried_value: sats(row.carried_value_sats),
    successor_txid: row.successor_txid,
    successor_vout: row.successor_vout,
    relic: row.relic === 1,
  };
}

function serializeArtifact(row: ArtifactRow, rings: RingRow[], atHeight: number): unknown {
  const artifact = artifactFromRow(row, rings.map(ringFromRow));
  const depth = depthAt(artifact, atHeight);
  const tier = tierFor(depth);
  const upcoming = nextTier(depth);
  return {
    artifact_id: row.artifact_id,
    birth_txid: row.birth_txid,
    birth_height: row.birth_height,
    birth_vout: row.birth_vout,
    endowment_sats: sats(row.endowment_sats),
    founding: row.founding === 1,
    status: row.status,
    carrier:
      row.carrier_txid === null
        ? null
        : {
            txid: row.carrier_txid,
            vout: row.carrier_vout,
            height: row.carrier_height,
            value: sats(row.carrier_value_sats),
            address: row.carrier_address,
          },
    claimant_xonly: row.claimant_xonly,
    commit: { txid: row.commit_txid, vout: row.commit_vout, height: row.commit_height },
    depth,
    tier: tier.index,
    tier_name: tier.name,
    next_tier: upcoming === null ? null : upcoming.name,
    blocks_to_next_tier: blocksToNextTier(depth),
    ring_count: row.ring_count,
    relic_height: row.relic_height,
    rings: rings.map(serializeRing),
  };
}

function serializeCarrier(row: CarrierRow): unknown {
  return {
    txid: row.txid,
    vout: row.vout,
    height: row.height,
    value: sats(row.value_sats),
    script_pubkey: row.script_hex,
    address: row.address,
    spent_height: row.spent_height,
    spent_txid: row.spent_txid,
  };
}

function serializeInvalidEvent(row: InvalidEventRow): unknown {
  return {
    id: row.id,
    height: row.height,
    block_index: row.block_index,
    sequence: row.sequence,
    txid: row.txid,
    reason: row.reason,
    detail: row.detail,
  };
}

function readLimit(request: ApiRequest, config: AppConfig): number {
  const raw = request.query['limit'];
  if (raw === undefined || raw === '') return config.api.defaultPageLimit;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid_limit', 'limit must be a positive integer');
  const value = Number.parseInt(raw, 10);
  if (value < 1) throw new HttpError(400, 'invalid_limit', 'limit must be at least 1');
  if (value > config.api.maxPageLimit) {
    throw new HttpError(400, 'invalid_limit', `limit must be at most ${config.api.maxPageLimit}`);
  }
  return value;
}

function readCursor(request: ApiRequest): { primary: number; secondary: string } | null {
  const raw = request.query['cursor'];
  if (raw === undefined || raw === '') return null;
  const parsed = decodeCursor(raw);
  if (parsed === null) throw new HttpError(400, 'invalid_cursor', 'cursor is not a cursor this API issued');
  return parsed;
}

function readBoolean(request: ApiRequest, key: string): boolean | undefined {
  const raw = request.query[key];
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new HttpError(400, 'invalid_query', `${key} must be true or false`);
}

function requireArtifactId(value: string): string {
  const id = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(400, 'invalid_artifact_id', 'artifact id must be 64 hex characters');
  return id;
}

/** Deterministic accent derived from the artifact id. Presentation only. */
function accentFor(artifactId: string): string {
  const hue = Number.parseInt(artifactId.slice(0, 4), 16) % 360;
  return `hsl(${hue} 42% 46%)`;
}

// --------------------------------------------------------------------- api

export class Api {
  private readonly router = new Router();
  private readonly limiter: RateLimiter;
  private readonly deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.deps = deps;
    this.limiter = new RateLimiter(deps.config.api.rateLimitMax, deps.config.api.rateLimitWindowMs);
    this.registerRoutes();
  }

  private base(): string {
    return this.deps.config.api.basePath;
  }

  private indexedHeight(): number {
    return this.deps.store.indexedHeight();
  }

  private registerRoutes(): void {
    const base = this.base();
    const r = this.router;

    r.get(`${base}/status`, (req) => this.status(req));
    r.get(`${base}/window`, (req) => this.window(req));
    r.get(`${base}/artifacts`, (req) => this.artifacts(req));
    r.get(`${base}/artifacts/:id`, (req) => this.artifact(req));
    r.get(`${base}/artifacts/:id/card`, (req) => this.card(req));
    r.get(`${base}/addresses/:address/holdings`, (req) => this.holdings(req));
    r.get(`${base}/carriers/:txid/:vout`, (req) => this.carrier(req));
    r.get(`${base}/census/current`, (req) => this.censusCurrent(req));
    r.get(`${base}/census/:epoch`, (req) => this.census(req));
    r.get(`${base}/museum`, (req) => this.museum(req));
    r.get(`${base}/leaderboard`, (req) => this.leaderboard(req));
    r.get(`${base}/shatter`, (req) => this.shatter(req));
    r.get(`${base}/invalid-events`, (req) => this.invalidEvents(req));
    r.get(`${base}/stats`, (req) => this.stats(req));
    r.get(`${base}/mempool`, (req) => this.mempoolView(req));
    r.post(`${base}/safety/outpoints`, (req) => this.safety(req));

    for (const prefix of [base, '']) {
      r.get(`${prefix}/health`, () => this.health());
      r.get(`${prefix}/ready`, () => this.ready());
      r.get(`${prefix}/metrics`, () => this.metricsText());
    }
    r.get('/openapi.json', () => this.openapi());
    r.get(`${base}/openapi.json`, () => this.openapi());
  }

  routes(): readonly { method: HttpMethod; pattern: string }[] {
    return this.router.patterns();
  }

  /** The single entry point. Applies rate limiting, headers and error mapping. */
  async handle(request: ApiRequest): Promise<ApiResponse> {
    const started = process.hrtime.bigint();
    let response: ApiResponse;
    try {
      const exempt = request.path.endsWith('/health') || request.path.endsWith('/ready');
      if (!exempt) {
        const verdict = this.limiter.check(request.clientId);
        if (!verdict.allowed) {
          throw new HttpError(429, 'rate_limited', 'too many requests, slow down');
        }
      }
      const match = this.router.match(request.method, request.path);
      if (match === null) throw new HttpError(404, 'not_found', `no route for ${request.method} ${request.path}`);
      request.params = match.params;
      response = await match.handler(request);
    } catch (error) {
      if (error instanceof HttpError) {
        response = json(error.status, { error: error.code, message: error.message, details: error.details ?? null });
      } else {
        this.deps.logger.error('request failed', { path: request.path, error: error as Error });
        response = json(500, { error: 'internal_error', message: 'the request could not be completed' });
      }
    }

    const cors = this.deps.config.api.corsOrigin;
    response.headers = {
      ...SECURITY_HEADERS,
      ...(cors === null ? {} : { 'access-control-allow-origin': cors, vary: 'origin' }),
      ...response.headers,
    };
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    this.deps.metrics.recordApiRequest(elapsed, response.status);
    return response;
  }

  // ------------------------------------------------------------- endpoints

  private status(_request: ApiRequest): ApiResponse {
    const indexed = this.indexedHeight();
    const tip = this.deps.tipHeight();
    return json(200, {
      network: this.deps.config.network,
      protocol_id: PROTOCOL_ID,
      spec_sha256: this.deps.config.deployment.specSha256,
      tip_height: tip,
      indexed_height: indexed,
      synced: tip >= 0 && indexed >= tip,
      parser_version: PARSER_VERSION,
      indexer_version: INDEXER_VERSION,
      counters: this.counters(indexed),
    });
  }

  private counters(atHeight: number): unknown {
    const counters = this.deps.store.counters(atHeight);
    return {
      artifacts_alive: counters.artifactsAlive,
      artifacts_relic: counters.artifactsRelic,
      founding_total: counters.foundingTotal,
      rings_total: counters.ringsTotal,
      deepest_live_depth: counters.deepestLiveDepth,
      endowment_total_sats: sats(counters.endowmentTotalSats),
    };
  }

  private window(_request: ApiRequest): ApiResponse {
    const deployment = this.deps.config.deployment;
    const indexed = this.indexedHeight();
    const tip = this.deps.tipHeight() >= 0 ? this.deps.tipHeight() : indexed;
    const state = windowStateAt(deployment, tip);
    const hOpen = deployment.hOpen;
    const hClose = deployment.hClose;
    const graceEnd = deployment.graceEnd;

    let blocksRemaining: number | null = null;
    if (hClose !== null && graceEnd !== null) {
      if (state === 'PENDING' || state === 'OPEN') blocksRemaining = Math.max(0, hClose - tip);
      else if (state === 'GRACE') blocksRemaining = Math.max(0, graceEnd - tip);
      else blocksRemaining = 0;
    }

    return json(200, {
      state,
      h_open: hOpen,
      h_close: hClose,
      grace_end: graceEnd,
      tip_height: tip,
      blocks_until_open: hOpen === null ? null : Math.max(0, hOpen - tip),
      blocks_remaining: blocksRemaining,
      founding_total: this.deps.store.countArtifacts().founding,
    });
  }

  private artifacts(request: ApiRequest): ApiResponse {
    const limit = readLimit(request, this.deps.config);
    const cursor = readCursor(request);
    const founding = readBoolean(request, 'founding');
    const statusRaw = request.query['status'];
    if (statusRaw !== undefined && statusRaw !== '' && statusRaw !== 'ALIVE' && statusRaw !== 'RELIC') {
      throw new HttpError(400, 'invalid_query', 'status must be ALIVE or RELIC');
    }
    const address = request.query['address'];
    const atHeight = this.indexedHeight();

    const rows = this.deps.store.listArtifacts({
      limit,
      ...(cursor === null ? {} : { cursorHeight: cursor.primary, cursorId: cursor.secondary }),
      ...(founding === undefined ? {} : { founding }),
      ...(statusRaw === undefined || statusRaw === '' ? {} : { status: statusRaw as 'ALIVE' | 'RELIC' }),
      ...(address === undefined || address === '' ? {} : { address }),
    });

    const page: Page<unknown> = buildPage(
      rows,
      limit,
      (row) => serializeArtifact(row, this.deps.store.getRings(row.artifact_id), atHeight),
      (row) => ({ primary: row.birth_height, secondary: row.artifact_id }),
    );
    return json(200, page);
  }

  private artifact(request: ApiRequest): ApiResponse {
    const id = requireArtifactId(request.params['id']);
    const row = this.deps.store.getArtifactRow(id);
    if (row === null) throw new HttpError(404, 'artifact_not_found', `no artifact with id ${id}`);
    return json(200, serializeArtifact(row, this.deps.store.getRings(id), this.indexedHeight()));
  }

  private card(request: ApiRequest): ApiResponse {
    const id = requireArtifactId(request.params['id']);
    const row = this.deps.store.getArtifactRow(id);
    if (row === null) throw new HttpError(404, 'artifact_not_found', `no artifact with id ${id}`);
    const rings = this.deps.store.getRings(id);
    const atHeight = this.indexedHeight();
    const artifact = artifactFromRow(row, rings.map(ringFromRow));
    const depth = depthAt(artifact, atHeight);
    const tier = tierFor(depth);
    const upcoming = nextTier(depth);
    return json(200, {
      artifact_id: id,
      short_id: `${id.slice(0, 8)}...${id.slice(-4)}`,
      title: `${tier.name} patina`,
      subtitle: row.founding === 1 ? 'Firstlight Seal' : 'Open era artifact',
      status: row.status,
      founding: row.founding === 1,
      depth,
      tier: tier.index,
      tier_name: tier.name,
      next_tier: upcoming === null ? null : upcoming.name,
      blocks_to_next_tier: blocksToNextTier(depth),
      endowment_sats: sats(row.endowment_sats),
      carrier_value_sats: sats(row.carrier_value_sats ?? 0),
      rings: rings.length,
      birth_height: row.birth_height,
      measured_at_height: atHeight,
      accent: accentFor(id),
      network: this.deps.config.network,
    });
  }

  private holdings(request: ApiRequest): ApiResponse {
    const address = request.params['address'];
    if (!/^[0-9A-Za-z]{10,120}$/.test(address)) {
      throw new HttpError(400, 'invalid_address', 'address is not in a form this API accepts');
    }
    const atHeight = this.indexedHeight();
    const rows = this.deps.store.holdings(address);
    let total = 0;
    for (const row of rows) total += row.carrier_value_sats ?? 0;
    return json(200, {
      address,
      count: rows.length,
      carried_value_total: sats(total),
      items: rows.map((row) => serializeArtifact(row, this.deps.store.getRings(row.artifact_id), atHeight)),
    });
  }

  private carrier(request: ApiRequest): ApiResponse {
    const txid = request.params['txid'].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new HttpError(400, 'invalid_txid', 'txid must be 64 hex characters');
    const voutRaw = request.params['vout'];
    if (!/^\d+$/.test(voutRaw)) throw new HttpError(400, 'invalid_vout', 'vout must be a non negative integer');
    const vout = Number.parseInt(voutRaw, 10);

    const row = this.deps.store.getCarrier(txid, vout);
    if (row === null) throw new HttpError(404, 'carrier_not_found', `no carrier at ${txid}:${vout}`);
    const atHeight = this.indexedHeight();
    const artifacts = this.deps.store.artifactsOnCarrier(txid, vout);
    return json(200, {
      carrier: serializeCarrier(row),
      artifact_count: artifacts.length,
      artifacts: artifacts.map((artifact) =>
        serializeArtifact(artifact, this.deps.store.getRings(artifact.artifact_id), atHeight),
      ),
    });
  }

  private censusCurrent(_request: ApiRequest): ApiResponse {
    return json(200, currentCensus(this.deps.store, this.indexedHeight()));
  }

  private census(request: ApiRequest): ApiResponse {
    const raw = request.params['epoch'];
    if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid_epoch', 'epoch must be a non negative integer');
    const epoch = Number.parseInt(raw, 10);
    const indexed = this.indexedHeight();
    if (indexed >= 0 && epoch > epochOf(indexed)) {
      throw new HttpError(404, 'epoch_not_reached', `epoch ${epoch} is beyond the indexed height ${indexed}`);
    }
    return json(200, censusForEpoch(this.deps.store, epoch, indexed));
  }

  private museum(request: ApiRequest): ApiResponse {
    const limit = readLimit(request, this.deps.config);
    const cursor = readCursor(request);
    const rows = this.deps.store.museum(limit, cursor?.primary, cursor?.secondary);
    return json(
      200,
      buildPage(
        rows,
        limit,
        (row) => ({ artifact_id: row.artifact_id, founding: row.founding === 1, ...(serializeRing(row) as object) }),
        (row) => ({ primary: row.depth, secondary: `${row.artifact_id}:${row.ring_index}` }),
      ),
    );
  }

  private leaderboard(request: ApiRequest): ApiResponse {
    const scope = request.query['scope'] ?? 'all';
    if (scope !== 'all' && scope !== 'founding') {
      throw new HttpError(400, 'invalid_query', 'scope must be all or founding');
    }
    const limit = readLimit(request, this.deps.config);
    const atHeight = this.indexedHeight();
    const rows = this.deps.store.leaderboard(limit, scope === 'founding');
    return json(200, {
      scope,
      measured_at_height: atHeight,
      items: rows.map((row, rank) => {
        const artifact = artifactFromRow(row, this.deps.store.getRings(row.artifact_id).map(ringFromRow));
        const depth = depthAt(artifact, atHeight);
        const tier = tierFor(depth);
        return {
          rank: rank + 1,
          artifact_id: row.artifact_id,
          founding: row.founding === 1,
          depth,
          tier: tier.index,
          tier_name: tier.name,
          carrier_height: row.carrier_height,
          carrier_value: sats(row.carrier_value_sats),
          endowment_sats: sats(row.endowment_sats),
        };
      }),
    });
  }

  private shatter(request: ApiRequest): ApiResponse {
    const limit = readLimit(request, this.deps.config);
    const cursor = readCursor(request);
    const rows = this.deps.store.shatter(limit, cursor?.primary, cursor?.secondary);
    return json(
      200,
      buildPage(
        rows,
        limit,
        (row) => ({ artifact_id: row.artifact_id, founding: row.founding === 1, ...(serializeRing(row) as object) }),
        (row) => ({ primary: row.end_height, secondary: `${row.artifact_id}:${row.ring_index}` }),
      ),
    );
  }

  private invalidEvents(request: ApiRequest): ApiResponse {
    const limit = readLimit(request, this.deps.config);
    const cursor = readCursor(request);
    const reason = request.query['reason'];
    if (reason !== undefined && reason !== '' && !(REASON_CODES as readonly string[]).includes(reason)) {
      throw new HttpError(400, 'invalid_reason', `${reason} is not a registered reason code`);
    }
    const rows = this.deps.store.listInvalidEvents(
      limit,
      cursor?.primary,
      reason === undefined || reason === '' ? undefined : reason,
    );
    return json(
      200,
      buildPage(rows, limit, serializeInvalidEvent, (row) => ({ primary: row.id, secondary: '' })),
    );
  }

  private stats(_request: ApiRequest): ApiResponse {
    const indexed = this.indexedHeight();
    const counters = this.deps.store.counters(indexed);
    const histories = this.deps.store.allArtifactHistories();
    const tierCounts = new Array<number>(TIERS.length).fill(0);
    let carriersHeld = 0;
    const carrierKeys = new Set<string>();
    for (const history of histories) {
      if (history.artifact.status !== 'ALIVE' || history.artifact.carrier_height === null) continue;
      const depth = Math.max(0, indexed - history.artifact.carrier_height);
      tierCounts[tierFor(depth).index] += 1;
      if (history.artifact.carrier_txid !== null && history.artifact.carrier_vout !== null) {
        carrierKeys.add(outpointKey(history.artifact.carrier_txid, history.artifact.carrier_vout));
      }
    }
    carriersHeld = carrierKeys.size;

    return json(200, {
      indexed_height: indexed,
      tip_height: this.deps.tipHeight(),
      counters: this.counters(indexed),
      tiers: TIERS.map((tier) => ({ index: tier.index, name: tier.name, threshold: tier.threshold, alive: tierCounts[tier.index] })),
      distribution: {
        live_carriers: carriersHeld,
        bundled_carriers: counters.artifactsAlive - carriersHeld,
        average_rings:
          counters.artifactsAlive + counters.artifactsRelic === 0
            ? '0.0000'
            : (counters.ringsTotal / (counters.artifactsAlive + counters.artifactsRelic)).toFixed(4),
      },
      invalid_events: {
        total: this.deps.store.invalidEventCount(),
        by_reason: this.deps.store.invalidEventBreakdown(),
      },
      reorgs_total: this.deps.store.reorgCount(),
      mempool: this.deps.mempool === undefined ? null : { entries: this.deps.mempool.count() },
    });
  }

  private mempoolView(_request: ApiRequest): ApiResponse {
    const overlay = this.deps.mempool;
    if (overlay === undefined) {
      return json(200, { enabled: false, entries: [], replacements: [], conflicts: [] });
    }
    return json(
      200,
      {
        enabled: true,
        provisional: true,
        note: 'These facts are unconfirmed and are never part of canonical state.',
        entries: overlay.entries().map((entry) => ({
          txid: entry.txid,
          kind: entry.kind,
          first_seen: entry.firstSeen,
          last_seen: entry.lastSeen,
          affected_artifacts: entry.affectedArtifacts,
          spent_outpoints: entry.spentOutpoints,
          summary: entry.summary,
        })),
        replacements: overlay.replacements(50),
        conflicts: overlay.conflicts(50),
      },
      { 'cache-control': 'no-store' },
    );
  }

  /**
   * Classify outpoints for a wallet that is about to build a transaction.
   * Nothing is written and nothing is cached. The response says no-store
   * because the request body is a list of the caller's own outpoints.
   */
  private safety(request: ApiRequest): ApiResponse {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'invalid_body', 'body must be a JSON object with an outpoints array');
    }
    const raw = (body as Record<string, unknown>)['outpoints'];
    if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_body', 'outpoints must be an array of "txid:vout"');
    if (raw.length > 500) throw new HttpError(400, 'too_many_outpoints', 'at most 500 outpoints per request');

    const pendingCommits = this.deps.mempool?.pendingCommitOutpoints() ?? new Map<string, string>();
    const pendingSpends = this.deps.mempool?.pendingCarrierSpends() ?? new Map();

    const results = raw.map((entry) => {
      if (typeof entry !== 'string') {
        throw new HttpError(400, 'invalid_outpoint', 'each outpoint must be a string of the form txid:vout');
      }
      let parsed: { txid: string; vout: number };
      try {
        parsed = parseOutpointKey(entry.toLowerCase());
      } catch {
        throw new HttpError(400, 'invalid_outpoint', `${entry} is not a valid txid:vout outpoint`);
      }
      const key = outpointKey(parsed.txid, parsed.vout);

      const carrier = this.deps.store.getCarrier(parsed.txid, parsed.vout);
      if (carrier !== null && carrier.spent_height === null) {
        const artifacts = this.deps.store.artifactsOnCarrier(parsed.txid, parsed.vout);
        return {
          outpoint: key,
          protected: true,
          kind: 'carrier' as const,
          artifact_ids: artifacts.map((row) => row.artifact_id),
          detail: `live carrier created at height ${carrier.height}`,
          provisional_spend: pendingSpends.has(key) ? pendingSpends.get(key)?.txid ?? null : null,
        };
      }

      const commit = this.deps.store.getCommit(parsed.txid, parsed.vout);
      if (commit !== null) {
        return {
          outpoint: key,
          protected: false,
          kind: 'commit' as const,
          artifact_ids: commit.artifact_id === null ? [] : [commit.artifact_id],
          detail:
            commit.status === 'REVEALED'
              ? `commit revealed by ${commit.reveal_txid} at height ${commit.reveal_height}`
              : `commit leaf revealed by ${commit.reveal_txid} but the SEED was rejected`,
          provisional_spend: null,
        };
      }

      const pending = pendingCommits.get(key);
      if (pending !== undefined) {
        return {
          outpoint: key,
          protected: true,
          kind: 'commit' as const,
          artifact_ids: [],
          detail: `an unconfirmed SEED transaction ${pending} spends this outpoint as a commit`,
          provisional_spend: pending,
        };
      }

      if (carrier !== null) {
        return {
          outpoint: key,
          protected: false,
          kind: 'carrier' as const,
          artifact_ids: this.deps.store.artifactsOnCarrier(parsed.txid, parsed.vout).map((row) => row.artifact_id),
          detail: `carrier already spent at height ${carrier.spent_height}`,
          provisional_spend: null,
        };
      }

      return {
        outpoint: key,
        protected: false,
        kind: 'none' as const,
        artifact_ids: [] as string[],
        detail: 'this outpoint plays no PATINA role in the indexed state',
        provisional_spend: null,
      };
    });

    return json(
      200,
      {
        network: this.deps.config.network,
        indexed_height: this.indexedHeight(),
        stored: false,
        outpoints: results,
      },
      { 'cache-control': 'no-store', pragma: 'no-cache' },
    );
  }

  private health(): ApiResponse {
    return json(200, { status: 'ok', network: this.deps.config.network, indexer_version: INDEXER_VERSION });
  }

  private ready(): ApiResponse {
    const indexed = this.indexedHeight();
    const tip = this.deps.tipHeight();
    const integrity = this.deps.store.checkIntegrity();
    const schemaOk = integrity.missing.length === 0;
    const lag = tip < 0 ? 0 : Math.max(0, tip - indexed);
    const ready = schemaOk && indexed >= 0 && lag <= 2;
    return json(ready ? 200 : 503, {
      ready,
      schema_ok: schemaOk,
      missing_tables: integrity.missing,
      indexed_height: indexed,
      tip_height: tip,
      tip_lag: lag,
    });
  }

  private metricsText(): ApiResponse {
    const indexed = this.indexedHeight();
    const tip = this.deps.tipHeight();
    const counters = this.deps.store.counters(indexed);
    const text = this.deps.metrics.render({
      network: this.deps.config.network,
      indexedHeight: indexed,
      tipHeight: tip < 0 ? indexed : tip,
      artifactsAlive: counters.artifactsAlive,
      artifactsRelic: counters.artifactsRelic,
      ringsTotal: counters.ringsTotal,
      foundingTotal: counters.foundingTotal,
      invalidEventsTotal: this.deps.store.invalidEventCount(),
      reorgsTotal: this.deps.store.reorgCount(),
      mempoolEntries: this.deps.mempool?.count() ?? 0,
      deepestLiveDepth: counters.deepestLiveDepth,
      endowmentTotalSats: counters.endowmentTotalSats,
      synced: tip >= 0 && indexed >= tip,
    });
    return { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }, body: text };
  }

  private openapi(): ApiResponse {
    return json(
      200,
      buildOpenApiDocument({
        basePath: this.base(),
        version: INDEXER_VERSION,
        network: this.deps.config.network,
        publicUrl: this.deps.config.api.publicUrl,
      }),
    );
  }
}

/** Build a request object for direct handler calls, as the tests do. */
export function apiRequest(
  method: HttpMethod,
  path: string,
  options: { query?: Record<string, string>; body?: unknown; clientId?: string } = {},
): ApiRequest {
  return {
    method,
    path,
    query: options.query ?? {},
    headers: {},
    body: options.body,
    clientId: options.clientId ?? 'test',
    params: {},
  };
}

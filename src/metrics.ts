/**
 * Prometheus text exposition, written by hand.
 *
 * A client library would add a dependency and a registry abstraction for the
 * eight series this service actually publishes. The format is stable and short,
 * so the exporter is a plain string builder with an explicit HELP and TYPE line
 * for every series.
 */

export interface HistogramSnapshot {
  readonly buckets: readonly { readonly le: number; readonly count: number }[];
  readonly sum: number;
  readonly count: number;
}

const DEFAULT_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram {
  private readonly bounds: readonly number[];
  private readonly counts: number[];
  private sum = 0;
  private total = 0;

  constructor(bounds: readonly number[] = DEFAULT_LATENCY_BUCKETS) {
    this.bounds = bounds;
    this.counts = new Array(bounds.length).fill(0);
  }

  observe(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.sum += seconds;
    this.total += 1;
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (seconds <= (this.bounds[i] as number)) this.counts[i] = (this.counts[i] as number) + 1;
    }
  }

  snapshot(): HistogramSnapshot {
    return {
      buckets: this.bounds.map((le, i) => ({ le, count: this.counts[i] as number })),
      sum: this.sum,
      count: this.total,
    };
  }
}

export interface MetricsState {
  readonly network: string;
  readonly indexedHeight: number;
  readonly tipHeight: number;
  readonly artifactsAlive: number;
  readonly artifactsRelic: number;
  readonly ringsTotal: number;
  readonly foundingTotal: number;
  readonly invalidEventsTotal: number;
  readonly reorgsTotal: number;
  readonly mempoolEntries: number;
  readonly deepestLiveDepth: number;
  readonly endowmentTotalSats: number;
  readonly synced: boolean;
}

/**
 * Counters the process owns, as opposed to values read from the database.
 * Everything here is monotonic apart from the gauges, which are set outright.
 */
export class Metrics {
  readonly apiLatency = new Histogram();
  private apiRequests = 0;
  private apiErrors = 0;
  private blocksApplied = 0;
  private blocksRolledBack = 0;
  private rpcCalls = 0;
  private rpcFailures = 0;
  private readonly startedAt = Date.now();

  recordApiRequest(seconds: number, status: number): void {
    this.apiRequests += 1;
    if (status >= 500) this.apiErrors += 1;
    this.apiLatency.observe(seconds);
  }

  recordBlockApplied(): void {
    this.blocksApplied += 1;
  }

  recordBlockRolledBack(): void {
    this.blocksRolledBack += 1;
  }

  recordRpcCall(failed: boolean): void {
    this.rpcCalls += 1;
    if (failed) this.rpcFailures += 1;
  }

  render(state: MetricsState): string {
    const labels = `{network="${state.network}"}`;
    const lines: string[] = [];

    const gauge = (name: string, help: string, value: number): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };
    const counter = (name: string, help: string, value: number): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${labels} ${value}`);
    };

    gauge('patina_indexed_height', 'Height of the last block applied to canonical state.', state.indexedHeight);
    gauge('patina_tip_height', 'Height of the chain tip as reported by Bitcoin Core.', state.tipHeight);
    gauge(
      'patina_tip_lag_blocks',
      'Chain tip height minus indexed height. Zero means the indexer is caught up.',
      Math.max(0, state.tipHeight - state.indexedHeight),
    );
    gauge('patina_synced', 'One when the indexer is caught up to the chain tip, zero otherwise.', state.synced ? 1 : 0);
    gauge('patina_artifacts_alive', 'Artifacts currently ALIVE.', state.artifactsAlive);
    gauge('patina_artifacts_relic', 'Artifacts currently RELIC.', state.artifactsRelic);
    gauge('patina_founding_total', 'Artifacts created inside the founding window.', state.foundingTotal);
    gauge('patina_rings_total', 'Closed rings across all artifacts.', state.ringsTotal);
    gauge('patina_deepest_live_depth', 'Deepest live stretch in blocks.', state.deepestLiveDepth);
    gauge('patina_endowment_total_sats', 'Sum of endowment values in satoshis.', state.endowmentTotalSats);
    gauge('patina_mempool_entries', 'Provisional mempool entries in the overlay.', state.mempoolEntries);
    gauge('patina_uptime_seconds', 'Seconds since the process started.', Math.floor((Date.now() - this.startedAt) / 1000));

    counter('patina_invalid_events_total', 'Invalid protocol attempts recorded since genesis.', state.invalidEventsTotal);
    counter('patina_reorgs_total', 'Reorganisations handled since genesis.', state.reorgsTotal);
    counter('patina_blocks_applied_total', 'Blocks applied by this process.', this.blocksApplied);
    counter('patina_blocks_rolled_back_total', 'Blocks rolled back by this process.', this.blocksRolledBack);
    counter('patina_rpc_calls_total', 'Bitcoin Core RPC calls made by this process.', this.rpcCalls);
    counter('patina_rpc_failures_total', 'Bitcoin Core RPC calls that failed.', this.rpcFailures);
    counter('patina_api_requests_total', 'API requests served by this process.', this.apiRequests);
    counter('patina_api_errors_total', 'API requests that returned a 5xx.', this.apiErrors);

    const histogram = this.apiLatency.snapshot();
    lines.push('# HELP patina_api_request_duration_seconds API request duration in seconds.');
    lines.push('# TYPE patina_api_request_duration_seconds histogram');
    for (const bucket of histogram.buckets) {
      lines.push(`patina_api_request_duration_seconds_bucket{network="${state.network}",le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(`patina_api_request_duration_seconds_bucket{network="${state.network}",le="+Inf"} ${histogram.count}`);
    lines.push(`patina_api_request_duration_seconds_sum${labels} ${histogram.sum}`);
    lines.push(`patina_api_request_duration_seconds_count${labels} ${histogram.count}`);

    return `${lines.join('\n')}\n`;
  }
}

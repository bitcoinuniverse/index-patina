/**
 * The OpenAPI document, built from the same base path the router uses so the
 * two cannot drift apart.
 */

export interface OpenApiOptions {
  readonly basePath: string;
  readonly version: string;
  readonly network: string;
  readonly publicUrl: string | null;
}

const SATS = { type: 'string', pattern: '^[0-9]+$', description: 'Satoshi amount as a decimal string.' } as const;

function ok(description: string, schema: unknown): unknown {
  return { description, content: { 'application/json': { schema } } };
}

export function buildOpenApiDocument(options: OpenApiOptions): unknown {
  const base = options.basePath;

  const ring = {
    type: 'object',
    required: ['index', 'start_height', 'end_height', 'depth', 'carried_value', 'relic'],
    properties: {
      index: { type: 'integer' },
      start_height: { type: 'integer' },
      end_height: { type: 'integer' },
      depth: { type: 'integer' },
      carried_value: SATS,
      successor_txid: { type: 'string', nullable: true },
      successor_vout: { type: 'integer', nullable: true },
      relic: { type: 'boolean' },
    },
  };

  const carrier = {
    type: 'object',
    nullable: true,
    properties: {
      txid: { type: 'string' },
      vout: { type: 'integer' },
      height: { type: 'integer' },
      value: SATS,
      address: { type: 'string', nullable: true },
    },
  };

  const artifact = {
    type: 'object',
    required: ['artifact_id', 'birth_txid', 'birth_height', 'status', 'depth', 'tier'],
    properties: {
      artifact_id: { type: 'string' },
      birth_txid: { type: 'string' },
      birth_height: { type: 'integer' },
      birth_vout: { type: 'integer' },
      endowment_sats: SATS,
      founding: { type: 'boolean' },
      status: { type: 'string', enum: ['ALIVE', 'RELIC'] },
      carrier,
      depth: { type: 'integer' },
      tier: { type: 'integer' },
      tier_name: { type: 'string' },
      next_tier: { type: 'string', nullable: true },
      blocks_to_next_tier: { type: 'integer', nullable: true },
      rings: { type: 'array', items: ring },
    },
  };

  const page = (items: unknown): unknown => ({
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items }, next_cursor: { type: 'string', nullable: true } },
  });

  const cursorParams = [
    { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
  ];

  const paths: Record<string, unknown> = {
    [`${base}/status`]: {
      get: {
        summary: 'Indexer status and counters.',
        responses: { '200': ok('Current status.', { type: 'object' }) },
      },
    },
    [`${base}/window`]: {
      get: {
        summary: 'Founding window state at the current tip.',
        responses: { '200': ok('Window state.', { type: 'object' }) },
      },
    },
    [`${base}/artifacts`]: {
      get: {
        summary: 'Artifacts, newest first.',
        parameters: [
          ...cursorParams,
          { name: 'founding', in: 'query', required: false, schema: { type: 'boolean' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['ALIVE', 'RELIC'] } },
          { name: 'address', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': ok('A page of artifacts.', page(artifact)) },
      },
    },
    [`${base}/artifacts/{id}`]: {
      get: {
        summary: 'One artifact with its rings.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('The artifact.', artifact), '404': ok('Unknown artifact.', { type: 'object' }) },
      },
    },
    [`${base}/artifacts/{id}/card`]: {
      get: {
        summary: 'Share card payload for one artifact.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('The card payload.', { type: 'object' }) },
      },
    },
    [`${base}/addresses/{address}/holdings`]: {
      get: {
        summary: 'Artifacts whose carrier pays this address.',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Holdings.', { type: 'object' }) },
      },
    },
    [`${base}/carriers/{txid}/{vout}`]: {
      get: {
        summary: 'One carrier and the artifacts resting on it.',
        parameters: [
          { name: 'txid', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'vout', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '200': ok('The carrier.', { type: 'object' }), '404': ok('Unknown carrier.', { type: 'object' }) },
      },
    },
    [`${base}/census/current`]: {
      get: { summary: 'Census for the epoch that holds the indexed tip.', responses: { '200': ok('Census row.', { type: 'object' }) } },
    },
    [`${base}/census/{epoch}`]: {
      get: {
        summary: 'Census for one 2016 block epoch.',
        parameters: [{ name: 'epoch', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': ok('Census row.', { type: 'object' }) },
      },
    },
    [`${base}/museum`]: {
      get: { summary: 'Longest completed rings.', parameters: cursorParams, responses: { '200': ok('A page of rings.', page(ring)) } },
    },
    [`${base}/leaderboard`]: {
      get: {
        summary: 'Deepest live stretches.',
        parameters: [
          { name: 'scope', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'founding'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { '200': ok('The leaderboard.', { type: 'object' }) },
      },
    },
    [`${base}/shatter`]: {
      get: { summary: 'Rings closed most recently first.', parameters: cursorParams, responses: { '200': ok('A page of rings.', page(ring)) } },
    },
    [`${base}/invalid-events`]: {
      get: {
        summary: 'Rejected protocol attempts with frozen reason codes.',
        parameters: [...cursorParams, { name: 'reason', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': ok('A page of invalid events.', page({ type: 'object' })) },
      },
    },
    [`${base}/stats`]: {
      get: { summary: 'Counters and distribution health.', responses: { '200': ok('Statistics.', { type: 'object' }) } },
    },
    [`${base}/mempool`]: {
      get: {
        summary: 'Provisional mempool overlay. Never part of canonical state.',
        responses: { '200': ok('Overlay contents.', { type: 'object' }) },
      },
    },
    [`${base}/safety/outpoints`]: {
      post: {
        summary: 'Classify outpoints so a wallet can avoid spending a carrier or a commit.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['outpoints'],
                properties: { outpoints: { type: 'array', items: { type: 'string' }, maxItems: 500 } },
              },
            },
          },
        },
        responses: { '200': ok('Classification. Never stored.', { type: 'object' }) },
      },
    },
    [`${base}/health`]: { get: { summary: 'Liveness.', responses: { '200': ok('Alive.', { type: 'object' }) } } },
    [`${base}/ready`]: {
      get: { summary: 'Readiness.', responses: { '200': ok('Ready.', { type: 'object' }), '503': ok('Not ready.', { type: 'object' }) } },
    },
    [`${base}/metrics`]: {
      get: {
        summary: 'Prometheus metrics.',
        responses: { '200': { description: 'Metrics.', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'PATINA indexer',
      version: options.version,
      description:
        'Read API over deterministically derived PATINA state. Satoshi amounts are decimal strings and heights are numbers.',
      license: { name: 'MIT' },
    },
    servers: [{ url: options.publicUrl ?? '/', description: `PATINA indexer on ${options.network}` }],
    paths,
  };
}

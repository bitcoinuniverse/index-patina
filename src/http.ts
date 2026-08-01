/**
 * A small HTTP layer over node:http.
 *
 * The router is deliberately tiny and the request type is a plain object, so
 * every endpoint can be exercised in tests by calling `handle()` directly with
 * no socket, no port and no timing. The node:http adapter is a thin translation
 * on top of the same `handle()`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type HttpMethod = 'GET' | 'POST' | 'HEAD' | 'OPTIONS';

export interface ApiRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly clientId: string;
  /** Path parameters filled in by the router. */
  params: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (request: ApiRequest) => Promise<ApiResponse> | ApiResponse;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers, body };
}

interface Route {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: Handler;
  readonly pattern: string;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  /** All registered patterns, used to build the OpenAPI document. */
  patterns(): readonly { method: HttpMethod; pattern: string }[] {
    return this.routes.map((route) => ({ method: route.method, pattern: route.pattern }));
  }

  match(method: HttpMethod, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = splitPath(path);
    let pathExists = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const spec = route.segments[i] as string;
        const actual = parts[i] as string;
        if (spec.startsWith(':')) {
          params[spec.slice(1)] = decodeURIComponent(actual);
        } else if (spec !== actual) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathExists = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      return { handler: route.handler, params };
    }
    if (pathExists) throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${path}`);
    return null;
  }
}

/**
 * Fixed window rate limiter keyed by client id. In process and dependency free.
 * Operators who terminate at a proxy should keep their own limiter in front;
 * this one exists so a bare deployment is never unbounded.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(clientId: string): { allowed: boolean; remaining: number; resetAt: number } {
    const time = this.now();
    const current = this.hits.get(clientId);
    if (!current || current.resetAt <= time) {
      const resetAt = time + this.windowMs;
      this.hits.set(clientId, { count: 1, resetAt });
      if (this.hits.size > 10000) this.sweep(time);
      return { allowed: true, remaining: this.max - 1, resetAt };
    }
    current.count += 1;
    return {
      allowed: current.count <= this.max,
      remaining: Math.max(0, this.max - current.count),
      resetAt: current.resetAt,
    };
  }

  private sweep(time: number): void {
    for (const [key, value] of this.hits) {
      if (value.resetAt <= time) this.hits.delete(key);
    }
  }
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
});

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'request body exceeds 256 KiB');
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

export function createNodeServer(handle: (request: ApiRequest) => Promise<ApiResponse>): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let response: ApiResponse;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const query: Record<string, string> = {};
        for (const [key, value] of url.searchParams) query[key] = value;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
        const method = (req.method ?? 'GET').toUpperCase();
        const body = method === 'POST' ? await readBody(req) : undefined;
        response = await handle({
          method: method as HttpMethod,
          path: url.pathname,
          query,
          headers,
          body,
          clientId: req.socket.remoteAddress ?? 'unknown',
          params: {},
        });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal_error';
        response = {
          status,
          headers: {},
          body: { error: code, message: (error as Error).message },
        };
      }
      const payload = typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? null);
      const headers: Record<string, string> = {
        'content-type': typeof response.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        ...SECURITY_HEADERS,
        ...response.headers,
      };
      headers['content-length'] = String(Buffer.byteLength(payload, 'utf8'));
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(payload);
    })();
  });
}

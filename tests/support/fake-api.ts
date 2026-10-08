/**
 * In-memory stand-in for the KeyCRM API: a `fetch` replacement that records
 * every request and answers from registered routes. No test touches the network.
 */

import type { FetchLike } from '../../src/client.js';

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  /** Header names are lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, or undefined when the request had none. */
  readonly body: unknown;
  /** The redirect mode the client asked for. */
  readonly redirect: RequestInit['redirect'];
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

interface Route {
  readonly method: string;
  readonly path: string | RegExp;
  readonly respond: Responder;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A paginated list in the shape KeyCRM documents (`PaginatedResponse`). */
export function page(data: unknown[], overrides: Record<string, unknown> = {}): Response {
  return json({
    total: data.length,
    current_page: 1,
    per_page: 15,
    data,
    first_page_url: 'https://openapi.keycrm.app/v1/list?page=1',
    last_page_url: 'https://openapi.keycrm.app/v1/list?page=1',
    next_page_url: null,
    ...overrides,
  });
}

/** A request that never completes by itself: it rejects when the client aborts it, as `fetch` does. */
export function hang(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    // AbortSignal.timeout() uses an unref'd timer, so something else has to keep the process alive meanwhile.
    const keepAlive = setTimeout(() => undefined, 60_000);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal?.reason);
    });
  });
}

function replay(template: Response): Responder {
  const body = template.text();
  return async () => {
    const content = await body;
    return new Response(content === '' ? null : content, { status: template.status, headers: template.headers });
  };
}

export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Route[] = [];

  /**
   * Registers a route. Later registrations win, so a test can override a default.
   * A fixed `Response` is turned into a template: every call gets a fresh copy.
   */
  on(method: string, path: string | RegExp, respond: Responder | Response): this {
    this.routes.unshift({ method, path, respond: typeof respond === 'function' ? respond : replay(respond) });
    return this;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url: new URL(url),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    };
    this.requests.push(request);

    const route = this.routes.find(
      (candidate) =>
        candidate.method === request.method &&
        (typeof candidate.path === 'string'
          ? candidate.path === request.url.pathname
          : candidate.path.test(request.url.pathname)),
    );
    if (route === undefined) {
      throw new Error(`FakeApi: no route for ${request.method} ${request.url.pathname}`);
    }
    return route.respond(request);
  };

  /** The only request recorded so far; fails the test when there is not exactly one. */
  get single(): RecordedRequest {
    if (this.requests.length !== 1) {
      throw new Error(`FakeApi: expected exactly one request, got ${this.requests.length}`);
    }
    return this.requests[0] as RecordedRequest;
  }
}

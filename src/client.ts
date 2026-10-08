/**
 * Minimal HTTP client for the KeyCRM API.
 *
 * Responsibilities:
 *  - send the API key as a bearer token;
 *  - stay within the documented request rate (20 per minute for one key);
 *  - apply a timeout to every request and never follow redirects;
 *  - never repeat a request on its own: a repeated POST would be a second lead card;
 *  - turn failures into typed errors whose messages never contain the key.
 *
 * Nothing is logged here: request and response bodies contain customer names,
 * phone numbers and addresses and must not end up in a log file.
 */

import type { Config } from './config.js';
import { API_BASE_PATH, type Endpoint } from './endpoints.js';
import { KeycrmApiError, KeycrmTransportError, RateLimitError, UnexpectedResponseError } from './errors.js';
import { RateLimiter, type RateWindow } from './rate-limit.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | undefined;

export interface RequestOptions {
  readonly pathParams?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** Sent as `filter[name]=value`, the form KeyCRM documents for every list. */
  readonly filter?: Readonly<Record<string, string | undefined>>;
  /** JSON request body. Omitted entirely when undefined. */
  readonly body?: unknown;
}

export interface KeycrmClientOptions {
  readonly config: Config;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable delay for tests; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** "A limit of up to 20 requests per minute for one API key" (docs.keycrm.app). */
export const RATE_WINDOWS: readonly RateWindow[] = [{ limit: 20, perMs: 60_000 }];
/** A wait of a few seconds is taken silently; a longer one is reported instead, so a tool call never hangs. */
const MAX_RATE_WAIT_MS = 5_000;
const MAX_ERROR_BODY_CHARS = 500;
const MAX_ERROR_DETAILS = 20;
const REDACTED = '[redacted]';

export class KeycrmClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: RateLimiter;

  constructor(options: KeycrmClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limiter = new RateLimiter(RATE_WINDOWS, options.now ?? Date.now);
  }

  /** Calls an API operation and returns the parsed JSON body, or null for an empty one. */
  async request<T = unknown>(endpoint: Endpoint, options: RequestOptions = {}): Promise<T> {
    const url = buildUrl(this.config.apiUrl, endpoint, options);

    const slot = this.limiter.reserve(MAX_RATE_WAIT_MS);
    if (!slot.granted) throw new RateLimitError(slot.waitMs);
    if (slot.waitMs > 0) await this.sleep(slot.waitMs);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
    };
    const init: RequestInit = {
      method: endpoint.method,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
      // A redirect would forward the API key to another host, and a redirected
      // POST is repeated as a GET without its body. Neither may happen silently.
      redirect: 'manual',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.toTransportError(endpoint, error);
    }
    return this.parse<T>(endpoint, response);
  }

  private async parse<T>(endpoint: Endpoint, response: Response): Promise<T> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The headers arrived but the body did not: the timeout or the connection cut it off.
      throw this.toTransportError(endpoint, error);
    }

    const operation = `${endpoint.method} ${endpoint.path}`;
    if (response.status >= 300 && response.status < 400) {
      throw new UnexpectedResponseError(
        `${operation} was answered with a redirect (HTTP ${response.status}), which the server does not follow. Check that KEYCRM_API_URL is the API origin itself.`,
      );
    }
    if (!response.ok) {
      throw this.toApiError(response.status, response.statusText, text);
    }
    if (text.trim() === '') {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UnexpectedResponseError(
        `${operation} was answered with HTTP ${response.status} and a body that is not valid JSON.`,
      );
    }
  }

  private toTransportError(endpoint: Endpoint, error: unknown): KeycrmTransportError {
    const operation = `${endpoint.method} ${endpoint.path}`;
    if (isTimeout(error)) {
      return new KeycrmTransportError('timeout', `${operation} timed out after ${this.config.timeoutMs / 1000} s.`);
    }
    return new KeycrmTransportError(
      'network',
      this.scrub(`${operation} failed: no usable response from ${this.config.apiUrl} (${networkCause(error)}).`),
    );
  }

  /**
   * The OpenAPI document shows only `{ "message": "…" }` for an error. A map of
   * field names to messages under `errors` is read as well when it is there,
   * since that is where a validation error would name the offending field.
   */
  private toApiError(status: number, statusText: string, text: string): KeycrmApiError {
    // Scrub before truncating: a secret cut in half by the limit would no longer be recognised.
    let message = this.scrub(text.trim()).slice(0, MAX_ERROR_BODY_CHARS) || statusText || 'Empty error response.';
    let details: string[] = [];

    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) {
        details = fieldErrors(parsed['errors']).map((line) => this.scrub(line));
        const apiMessage = parsed['message'];
        if (typeof apiMessage === 'string' && apiMessage !== '') {
          message = this.scrub(apiMessage).slice(0, MAX_ERROR_BODY_CHARS);
        } else if (details.length > 0) {
          message = 'The request was refused.';
        }
      }
    } catch {
      // Not JSON (for example an HTML error page from a proxy): keep the truncated text.
    }

    return new KeycrmApiError(status, message, details);
  }

  /** Defence in depth: removes the API key from any text that leaves the client. */
  private scrub(text: string): string {
    const { apiKey } = this.config;
    return apiKey.length >= 4 ? text.split(apiKey).join(REDACTED) : text;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldErrors(errors: unknown): string[] {
  if (!isObject(errors)) return [];
  const lines: string[] = [];
  for (const [field, messages] of Object.entries(errors)) {
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      if (typeof message === 'string' && lines.length < MAX_ERROR_DETAILS) {
        lines.push(`${field}: ${message}`.slice(0, MAX_ERROR_BODY_CHARS));
      }
    }
  }
  return lines;
}

function buildUrl(apiUrl: string, endpoint: Endpoint, options: RequestOptions): string {
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = options.pathParams?.[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing path parameter "${name}" for ${endpoint.path}.`);
    }
    // encodeURIComponent leaves dots alone, and URL parsing would resolve "." and ".."
    // as path segments, redirecting the request to a different endpoint.
    if (value === '.' || value === '..') {
      throw new Error(`Invalid value for path parameter "${name}".`);
    }
    return encodeURIComponent(String(value));
  });

  const url = new URL(apiUrl + API_BASE_PATH + path);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.append(name, String(value));
  }
  for (const [name, value] of Object.entries(options.filter ?? {})) {
    if (value !== undefined) url.searchParams.append(`filter[${name}]`, value);
  }
  return url.toString();
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function networkCause(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return error.message;
}

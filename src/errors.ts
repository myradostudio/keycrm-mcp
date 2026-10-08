/**
 * Error types and the single place where an error becomes text for the model.
 *
 * Tool handlers never let a stack trace reach the MCP client: `describeError`
 * turns any thrown value into a short, actionable message.
 */

/** The API answered with a non-2xx status. */
export class KeycrmApiError extends Error {
  readonly status: number;
  /** Field-level problems, already formatted as `field: message`, when the API sent any. */
  readonly details: readonly string[];

  constructor(status: number, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'KeycrmApiError';
    this.status = status;
    this.details = details;
  }
}

/** No usable HTTP response: the request timed out or the network failed. */
export class KeycrmTransportError extends Error {
  readonly kind: 'timeout' | 'network';

  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'KeycrmTransportError';
    this.kind = kind;
  }
}

/**
 * A response arrived but cannot be interpreted: a redirect, or a success status
 * with a body that is not JSON. For a write this leaves the outcome unknown.
 */
export class UnexpectedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}

/** The request was not sent because it would exceed the request rate KeyCRM documents. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Not sent: KeyCRM allows 20 requests per minute for one API key, and this server has used that up. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`,
    );
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A problem the tool itself detected (bad combination of arguments, unexpected response shape). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// The statuses the OpenAPI document names for the operations this server calls.
const STATUS_HINTS: Readonly<Record<number, string>> = {
  400: 'For pipelines KeyCRM documents this answer as "the pipelines section is switched off in the CRM settings".',
  401: 'KeyCRM rejected the API key. Check KEYCRM_API_KEY.',
  403: 'For a new pipeline card KeyCRM documents this answer as "wrong arguments, or pipelines are not activated".',
  404: 'KeyCRM did not find an object with this id.',
  429: 'Rate limit reached: KeyCRM allows 20 requests per minute for one API key. Wait before retrying.',
};

export function describeError(error: unknown): string {
  if (error instanceof KeycrmApiError) {
    const lines = [`KeyCRM API error (HTTP ${error.status}): ${error.message}`];
    for (const detail of error.details) lines.push(`  - ${detail}`);
    const hint = STATUS_HINTS[error.status];
    if (hint !== undefined) lines.push(hint);
    return lines.join('\n');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error.';
}

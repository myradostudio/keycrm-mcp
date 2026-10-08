/**
 * Environment-based configuration.
 *
 * Everything is validated once at startup. Problems are collected and reported
 * together so a user fixing their MCP client config does not have to restart
 * the server once per mistake.
 */

export const DEFAULT_API_URL = 'https://openapi.keycrm.app';
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface Config {
  /** API origin without a trailing slash, e.g. `https://openapi.keycrm.app`. */
  readonly apiUrl: string;
  /** API key of the KeyCRM account (`Authorization: Bearer …`). */
  readonly apiKey: string;
  /** When false (the default) no write tool is registered at all. */
  readonly allowWrite: boolean;
  readonly timeoutMs: number;
  /** Non-fatal remarks to print on stderr at startup. Never contain secrets. */
  readonly notices: readonly string[];
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Reads a variable, treating blank values (common in config templates) as unset. */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseApiUrl(raw: string | undefined, problems: string[]): string {
  if (raw === undefined) return DEFAULT_API_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`KEYCRM_API_URL is not a valid URL (expected something like ${DEFAULT_API_URL}).`);
    return DEFAULT_API_URL;
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    problems.push('KEYCRM_API_URL must use https:// (plain http:// is accepted only for localhost).');
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('KEYCRM_API_URL must not contain credentials.');
  }
  if (url.pathname.replace(/\/+$/, '') !== '' || url.search !== '' || url.hash !== '') {
    problems.push(
      `KEYCRM_API_URL must be the API origin only, without a path or query (for example ${DEFAULT_API_URL}).`,
    );
  }
  return url.origin;
}

function parseAllowWrite(raw: string | undefined, problems: string[]): boolean {
  const value = (raw ?? '').toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  // Fail closed and loudly: a typo must never silently enable or disable writes to the CRM.
  problems.push('KEYCRM_ALLOW_WRITE must be 1 (enable write tools) or 0 (read-only, the default).');
  return false;
}

function parseApiKey(raw: string | undefined, problems: string[], notices: string[]): string {
  if (raw === undefined) {
    problems.push(
      'KEYCRM_API_KEY is not set. KeyCRM explains where to get the key at https://help.keycrm.app/uk/process-automation-api-and-more/where-to-get-an-api-key',
    );
    return '';
  }
  let key = raw;
  if (/^bearer\s+/i.test(key)) {
    key = key.replace(/^bearer\s+/i, '');
    notices.push('KEYCRM_API_KEY started with "Bearer "; the prefix was dropped, the server adds it itself.');
  }
  if (/\s/.test(key)) {
    problems.push('KEYCRM_API_KEY must be the API key alone, without spaces or line breaks.');
  } else if (!/^[\x21-\x7e]+$/.test(key)) {
    // A header value cannot carry anything else: every request would fail inside fetch before it is sent.
    problems.push(
      'KEYCRM_API_KEY contains a character that is not a plain Latin letter, digit or sign (a curly quote or an invisible space, often picked up when copying from a document). Copy the key again.',
    );
  }
  return key;
}

/**
 * Builds the configuration from environment variables.
 * @throws {ConfigError} listing every problem found.
 */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const notices: string[] = [];

  const apiKey = parseApiKey(read(env, 'KEYCRM_API_KEY'), problems, notices);
  const apiUrl = parseApiUrl(read(env, 'KEYCRM_API_URL'), problems);
  const allowWrite = parseAllowWrite(read(env, 'KEYCRM_ALLOW_WRITE'), problems);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return { apiUrl, apiKey, allowWrite, timeoutMs: DEFAULT_TIMEOUT_MS, notices };
}

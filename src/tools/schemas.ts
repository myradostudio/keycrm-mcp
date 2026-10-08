/** Zod building blocks shared by the tool input schemas, plus pagination and filter helpers. */

import { z } from 'zod';

import { ToolError } from '../errors.js';

/** The page size KeyCRM uses when none is asked for. */
export const DEFAULT_LIMIT = 15;
/** "Maximum 50" (the `limit` parameter of every list in the OpenAPI document). */
export const MAX_LIMIT = 50;

export const id = (what: string) => z.number().int().min(1).describe(`${what} (a positive integer).`);

export const idList = (what: string) => z.array(z.number().int().min(1)).min(1).max(50).optional().describe(`${what}.`);

/**
 * A short pattern instead of `z.iso.datetime()`: the latter puts a 400-character
 * regular expression into the JSON Schema of every date argument of every tool.
 */
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Date.parse alone is not enough: it turns 31 April into 1 May, and a moment at the edge of year 9999 moves into a
 * five-digit year in UTC. Either would quietly ask KeyCRM about another period than the one that was meant.
 */
function isRealMoment(value: string): boolean {
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || !day.toISOString().startsWith(value.slice(0, 10))) return false;
  const moment = new Date(value);
  return !Number.isNaN(moment.getTime()) && /^\d{4}-/.test(moment.toISOString());
}

export const dateTime = (what: string) =>
  z
    .string()
    .regex(DATE_TIME_PATTERN, 'Must be an ISO 8601 date-time with a UTC offset, e.g. 2026-10-01T00:00:00+03:00.')
    .refine(isRealMoment, 'Not a valid date-time.')
    .describe(
      `${what} ISO 8601 with a UTC offset, e.g. 2026-10-01T00:00:00+03:00 (Kyiv is +02:00 in winter, +03:00 in summer). The server converts it to UTC, which is what KeyCRM works in.`,
    );

/** KeyCRM writes moments as `YYYY-MM-DD HH:MM:SS` in UTC, in filters and in request bodies alike. */
export function toUtc(value: string): string {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

/** Builds the value of a `*_between` filter; both ends are needed, since the filter is a range. */
export function between(from: string | undefined, to: string | undefined, name: string): string | undefined {
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined || to === undefined) {
    throw new ToolError(`${name}_from and ${name}_to must be given together: KeyCRM filters by a range.`);
  }
  if (Date.parse(from) > Date.parse(to)) {
    throw new ToolError(`${name}_from must not be later than ${name}_to.`);
  }
  return `${toUtc(from)},${toUtc(to)}`;
}

/** Several values of one filter are passed separated by commas. */
export function joined(values: readonly (string | number)[] | undefined): string | undefined {
  return values === undefined ? undefined : values.join(',');
}

/** A contact value used as a filter: commas would be read as a separator between several values. */
export const filterText = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^,]+$/, 'Must not contain a comma.')
    .describe(what);

export const include = <const Values extends readonly [string, ...string[]]>(values: Values, hint: string) =>
  z
    .array(z.enum(values))
    .min(1)
    .optional()
    .describe(`Related data to return with each record. Nothing is included by default. ${hint}`);

export const limit = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(`Page size. Default ${DEFAULT_LIMIT}; values above ${MAX_LIMIT}, the maximum of the API, are clamped.`);

export const page = z.number().int().min(1).optional().describe('Page number, starting from 1. Default 1.');

export interface Page {
  readonly limit: number;
  readonly page: number;
}

export function resolvePage(args: { limit?: number | undefined; page?: number | undefined }): Page {
  return { limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT), page: args.page ?? 1 };
}

type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/**
 * Wraps a paginated API response (`{ total, current_page, per_page, data, next_page_url, … }`)
 * into the shape every list tool returns.
 */
export function paginated(response: unknown, requested: Page, mapItem: (item: Json) => unknown = (item) => item) {
  if (!isObject(response) || !Array.isArray(response['data'])) {
    throw new ToolError('Unexpected response from the KeyCRM API: a paginated list was expected.');
  }
  const results = objects(response['data']).map(mapItem);
  const total = response['total'];
  const nextUrl = response['next_page_url'];
  // Without the field the answer is derived: a full page means there may be more.
  const hasNext = nextUrl === undefined ? results.length >= requested.limit : typeof nextUrl === 'string' && nextUrl !== '';

  return {
    pagination: {
      page: requested.page,
      limit: requested.limit,
      returned: results.length,
      ...(typeof total === 'number' ? { total } : {}),
      next_page: hasNext ? requested.page + 1 : null,
    },
    results,
  };
}

/**
 * Checks recorded requests against the snapshot of the official OpenAPI document
 * (spec/keycrm-api.snapshot.json, refreshed with `npm run spec:update`).
 *
 * This is a deliberately small JSON Schema checker covering the keywords the
 * KeyCRM document uses for the operations this server calls. Unknown query
 * parameters, filters, `include` values and body properties are reported: the
 * server must not send what the API does not define.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { API_BASE_PATH } from '../../src/endpoints.js';
import type { RecordedRequest } from './fake-api.js';

type Schema = Record<string, unknown>;

interface Parameter {
  readonly name: string;
  readonly in: 'query' | 'header' | 'path';
  readonly required: boolean;
  readonly schema: Schema;
}

export interface Operation {
  readonly security: boolean;
  readonly parameters: readonly Parameter[];
  readonly successStatuses: readonly string[];
  /** Names shown in the examples of the `filter` parameter; absent when the list has no filter. */
  readonly filterNames?: readonly string[];
  /** "Allowed associations" of the `include` parameter; absent when there is no such parameter. */
  readonly includeValues?: readonly string[];
  readonly requestBody?: { readonly required: boolean; readonly schema: Schema };
}

interface Snapshot {
  readonly source: string;
  readonly title: string;
  readonly version: string;
  readonly server: string;
  readonly operations: Readonly<Record<string, Operation>>;
  readonly schemas: Readonly<Record<string, Schema>>;
}

// Compiled tests live in build-test/tests/support/, three levels below the repository root.
export const snapshot = JSON.parse(
  readFileSync(new URL('../../../spec/keycrm-api.snapshot.json', import.meta.url), 'utf8'),
) as Snapshot;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolve(schema: Schema): Schema {
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return schema;
  const name = ref.split('/').pop() ?? '';
  const target = snapshot.schemas[name];
  assert.ok(target, `schema ${name} is missing from the snapshot`);
  return target;
}

/** Returns a list of violations; an empty list means the value fits the schema. */
export function validate(rawSchema: Schema, value: unknown, path: string): string[] {
  const schema = resolve(rawSchema);
  const errors: string[] = [];

  if (value === null) return schema['nullable'] === true ? [] : [`${path}: null is not allowed`];

  const allowed = schema['enum'] as unknown[] | undefined;
  if (allowed !== undefined && !allowed.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
  }

  const type = schema['type'] ?? (schema['properties'] !== undefined ? 'object' : undefined);
  switch (type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected a string`);
      break;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) {
        return [...errors, `${path}: expected ${type === 'integer' ? 'an integer' : 'a number'}`];
      }
      const { minimum, maximum } = schema as { minimum?: number; maximum?: number };
      if (minimum !== undefined && value < minimum) errors.push(`${path}: below ${minimum}`);
      if (maximum !== undefined && value > maximum) errors.push(`${path}: above ${maximum}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected a boolean`);
      break;
    case 'array': {
      if (!Array.isArray(value)) return [...errors, `${path}: expected an array`];
      const items = schema['items'] as Schema | undefined;
      if (items !== undefined) {
        value.forEach((item, index) => errors.push(...validate(items, item, `${path}[${index}]`)));
      }
      break;
    }
    case 'object': {
      if (!isObject(value)) return [...errors, `${path}: expected an object`];
      const properties = schema['properties'] as Record<string, Schema> | undefined;
      for (const name of (schema['required'] as string[] | undefined) ?? []) {
        if (value[name] === undefined) errors.push(`${path}.${name}: required by the spec but missing`);
      }
      if (properties !== undefined) {
        for (const [name, item] of Object.entries(value)) {
          const property = properties[name];
          if (property === undefined) errors.push(`${path}.${name}: not defined in the spec`);
          else errors.push(...validate(property, item, `${path}.${name}`));
        }
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

/** Converts a query-string or path value to the type its schema declares, as the API server would. */
function coerce(schema: Schema, raw: string): unknown {
  const type = schema['type'];
  if (type === 'integer' || type === 'number') return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  return raw;
}

function findOperation(request: RecordedRequest): { key: string; operation: Operation; pathParams: Record<string, string> } {
  assert.ok(
    request.url.pathname.startsWith(`${API_BASE_PATH}/`),
    `${request.url.pathname} is outside the documented server path ${API_BASE_PATH}`,
  );
  const pathname = request.url.pathname.slice(API_BASE_PATH.length);

  // A literal path such as /order/status must not be taken for /order/{orderId}.
  const literal = snapshot.operations[`${request.method} ${pathname}`];
  if (literal !== undefined) return { key: `${request.method} ${pathname}`, operation: literal, pathParams: {} };

  for (const [key, operation] of Object.entries(snapshot.operations)) {
    const [method = '', template = ''] = key.split(' ');
    if (method !== request.method) continue;
    const names: string[] = [];
    const pattern = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (match === null) continue;
    const pathParams = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]));
    return { key, operation, pathParams };
  }
  assert.fail(`${request.method} ${pathname} is not an operation of the KeyCRM OpenAPI snapshot`);
}

const FILTER_KEY = /^filter\[(\w+)\]$/;

/**
 * Asserts that a request the server sent is valid according to the spec:
 * known operation, declared and well-typed path and query parameters, only
 * documented filters and `include` values, the bearer key, and a body that fits
 * the request schema.
 * Returns the matched operation key, e.g. `GET /order`.
 */
export function assertMatchesSpec(request: RecordedRequest): string {
  const { key, operation, pathParams } = findOperation(request);
  const errors: string[] = [];
  const parameters = (location: Parameter['in']) => operation.parameters.filter((parameter) => parameter.in === location);

  for (const parameter of parameters('path')) {
    const raw = pathParams[parameter.name] ?? '';
    errors.push(...validate(parameter.schema, coerce(parameter.schema, raw), `path.${parameter.name}`));
  }

  const query = parameters('query');
  for (const name of new Set(request.url.searchParams.keys())) {
    const values = request.url.searchParams.getAll(name);
    if (values.length !== 1) errors.push(`query.${name}: sent ${values.length} times`);
    const value = values[0] ?? '';

    const filter = FILTER_KEY.exec(name)?.[1];
    if (filter !== undefined) {
      // `filter` is a deepObject parameter: filter[field]=value.
      if (!(operation.filterNames ?? []).includes(filter)) errors.push(`query.${name}: not a filter the document shows for ${key}`);
      if (value === '') errors.push(`query.${name}: empty`);
      continue;
    }

    const parameter = query.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      errors.push(`query.${name}: not a query parameter of ${key}`);
      continue;
    }
    errors.push(...validate(parameter.schema, coerce(parameter.schema, value), `query.${name}`));
    if (name === 'include') {
      for (const item of value.split(',')) {
        if (!(operation.includeValues ?? []).includes(item)) errors.push(`query.include: "${item}" is not an allowed association of ${key}`);
      }
    }
  }
  for (const parameter of query) {
    if (parameter.required && !request.url.searchParams.has(parameter.name)) {
      errors.push(`query.${parameter.name}: required by the spec but missing`);
    }
  }

  const authorization = request.headers['authorization'];
  if (operation.security && !/^Bearer \S+$/.test(authorization ?? '')) {
    errors.push('header Authorization: the operation is secured but no bearer key was sent');
  }
  if (request.headers['accept'] !== 'application/json') errors.push('header Accept: must be application/json');

  if (operation.requestBody === undefined) {
    if (request.body !== undefined) errors.push('body: the operation does not take a request body');
  } else if (request.body === undefined) {
    if (operation.requestBody.required) errors.push('body: required by the spec but missing');
  } else {
    errors.push(...validate(operation.requestBody.schema, request.body, 'body'));
    if (request.headers['content-type'] !== 'application/json') {
      errors.push('header Content-Type: must be application/json when a body is sent');
    }
  }

  assert.deepEqual(errors, [], `${request.method} ${request.url.pathname}${request.url.search} violates the spec`);
  return key;
}

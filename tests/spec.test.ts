/**
 * The endpoint catalogue (src/endpoints.ts) and the lists of `include` values
 * must agree with the snapshot of the official OpenAPI document.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { API_BASE_PATH, ENDPOINTS, type Endpoint } from '../src/endpoints.js';
import {
  BUYER_INCLUDES,
  BUYER_LIST_INCLUDES,
  CARD_INCLUDES,
  CARD_LIST_INCLUDES,
  ORDER_INCLUDES,
  ORDER_LIST_INCLUDES,
} from '../src/tools/read.js';
import { snapshot, validate } from './support/spec.js';

const entries = Object.entries(ENDPOINTS) as [string, Endpoint][];
const operation = (key: string) => {
  const found = snapshot.operations[key];
  assert.ok(found, `${key} is missing from the snapshot`);
  return found;
};

describe('endpoint catalogue vs. OpenAPI snapshot', () => {
  it('uses a snapshot taken from the official document', () => {
    assert.equal(snapshot.source, 'https://docs.keycrm.app/api.yaml');
    assert.match(snapshot.version, /^\d+\.\d+\.\d+/);
    assert.equal(snapshot.server, `https://openapi.keycrm.app${API_BASE_PATH}`);
  });

  it('covers exactly the operations in the catalogue', () => {
    const catalogue = entries.map(([, endpoint]) => `${endpoint.method} ${endpoint.path}`).sort();
    assert.deepEqual(Object.keys(snapshot.operations).sort(), catalogue);
  });

  for (const [name, endpoint] of entries) {
    it(`${name}: ${endpoint.method} ${endpoint.path}`, () => {
      const found = operation(`${endpoint.method} ${endpoint.path}`);

      assert.equal(found.security, true, 'secured with the bearer key');
      assert.ok(found.successStatuses.length > 0, 'documents a success response');

      const templateParams = [...endpoint.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const specParams = found.parameters.filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name);
      assert.deepEqual(templateParams.sort(), specParams.sort(), 'path parameters');
    });
  }

  it('only POSTs where the document describes creating a card', () => {
    const posts = entries.filter(([, endpoint]) => endpoint.method === 'POST').map(([name]) => name);
    assert.deepEqual(posts, ['createPipelineCard']);
    assert.deepEqual(operation('POST /pipelines/cards').successStatuses, ['201']);
  });
});

describe('include values vs. the allowed associations of the document', () => {
  const cases: [string, readonly string[], string[]][] = [
    ['orders', ORDER_INCLUDES, ['GET /order', 'GET /order/{orderId}']],
    ['buyers', BUYER_INCLUDES, ['GET /buyer', 'GET /buyer/{buyerId}']],
    ['pipeline cards', CARD_INCLUDES, ['GET /pipelines/cards', 'GET /pipelines/cards/{cardId}']],
  ];

  for (const [name, values, keys] of cases) {
    it(`${name}: the get tool offers exactly what the document allows`, () => {
      for (const key of keys) {
        assert.deepEqual([...values].sort(), [...(operation(key).includeValues ?? [])].sort(), key);
      }
    });
  }

  it('the list tools offer a part of it: only what their summaries show', () => {
    const subsets: [readonly string[], readonly string[], string][] = [
      [ORDER_LIST_INCLUDES, ORDER_INCLUDES, 'GET /order'],
      [BUYER_LIST_INCLUDES, BUYER_INCLUDES, 'GET /buyer'],
      [CARD_LIST_INCLUDES, CARD_INCLUDES, 'GET /pipelines/cards'],
    ];
    for (const [list, full, key] of subsets) {
      assert.ok(list.length > 0 && list.length < full.length, key);
      for (const value of list) assert.ok((operation(key).includeValues ?? []).includes(value), `${key}: ${value}`);
    }
  });
});

describe('filters shown by the document', () => {
  // The tools are held to these names by assertMatchesSpec; this test notices when the document drops or adds one.
  it('are still the ones the list tools were written for', () => {
    assert.deepEqual(operation('GET /order').filterNames, [
      'buyer_email',
      'buyer_phone',
      'created_between',
      'has_tracking_code',
      'payment_status',
      'shipping_between',
      'source_id',
      'source_uuid',
      'status_id',
      'updated_between',
    ]);
    assert.deepEqual(operation('GET /buyer').filterNames, ['buyer_email', 'buyer_id', 'buyer_phone', 'created_between', 'updated_between']);
    assert.deepEqual(operation('GET /pipelines/cards').filterNames, [
      'created_between',
      'pipeline_id',
      'source_id',
      'status_id',
      'updated_between',
    ]);
  });

  it('caps the page size at 50', () => {
    for (const key of ['GET /order', 'GET /buyer', 'GET /pipelines/cards', 'GET /pipelines', 'GET /users']) {
      const limit = operation(key).parameters.find((parameter) => parameter.name === 'limit');
      assert.equal(limit?.schema['maximum'], 50, key);
    }
  });
});

describe('spec checker', () => {
  const body = operation('POST /pipelines/cards').requestBody?.schema ?? {};

  it('accepts a minimal valid card', () => {
    assert.deepEqual(validate(body, { contact: { phone: '+380501234567' } }, 'body'), []);
  });

  it('reports fields the spec does not define', () => {
    const errors = validate(body, { contact: { phone: '+380501234567', telegram: '@x' }, comment: 'x' }, 'body');
    assert.deepEqual(errors, ['body.contact.telegram: not defined in the spec', 'body.comment: not defined in the spec']);
  });

  it('reports missing required fields and wrong types', () => {
    const errors = validate(body, { title: 5, pipeline_id: '3', custom_fields: [{ uuid: 1 }] }, 'body');
    assert.deepEqual(errors, [
      'body.contact: required by the spec but missing',
      'body.title: expected a string',
      'body.pipeline_id: expected an integer',
      'body.custom_fields[0].uuid: expected a string',
    ]);
  });

  it('allows null only where the document says nullable', () => {
    assert.deepEqual(validate(body, { contact: { phone: null }, title: null }, 'body'), []);
    assert.deepEqual(validate(body, { contact: null }, 'body'), ['body.contact: null is not allowed']);
  });
});

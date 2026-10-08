import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KeycrmClient, RATE_WINDOWS } from '../src/client.js';
import { ENDPOINTS } from '../src/endpoints.js';
import { describeError, KeycrmApiError, KeycrmTransportError, RateLimitError, UnexpectedResponseError } from '../src/errors.js';
import { RateLimiter } from '../src/rate-limit.js';
import { FakeApi, hang, json, page } from './support/fake-api.js';
import { API_KEY, testConfig } from './support/harness.js';

function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  const api = new FakeApi();
  const waits: number[] = [];
  let now = 1_000_000;
  const client = new KeycrmClient({
    config: testConfig(overrides),
    fetch: api.fetch,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  return { api, client, waits, advance: (ms: number) => (now += ms) };
}

describe('requests', () => {
  it('sends the API key as a bearer token, asks for JSON and names itself', async () => {
    const { api, client } = setup();
    api.on('GET', '/v1/order', page([]));

    await client.request(ENDPOINTS.orders);

    const { headers, method, url, redirect, body } = api.single;
    assert.equal(method, 'GET');
    assert.equal(url.href, 'https://openapi.keycrm.test/v1/order');
    assert.equal(headers['authorization'], `Bearer ${API_KEY}`);
    assert.equal(headers['accept'], 'application/json');
    assert.equal(headers['content-type'], undefined, 'no Content-Type without a body');
    assert.match(headers['user-agent'] ?? '', /^keycrm-mcp\/\d+\.\d+\.\d+$/);
    assert.equal(redirect, 'manual');
    assert.equal(body, undefined);
  });

  it('sends filters as filter[name]=value and skips undefined values', async () => {
    const { api, client } = setup();
    api.on('GET', '/v1/order', page([]));

    await client.request(ENDPOINTS.orders, {
      query: { limit: 50, page: 2, sort: undefined },
      filter: { status_id: '1,4', buyer_phone: '+380501234567', source_id: undefined },
    });

    const { searchParams } = api.single.url;
    assert.deepEqual([...searchParams.keys()], ['limit', 'page', 'filter[status_id]', 'filter[buyer_phone]']);
    assert.equal(searchParams.get('filter[status_id]'), '1,4');
    assert.equal(searchParams.get('filter[buyer_phone]'), '+380501234567', 'the plus sign survives encoding');
  });

  it('encodes path parameters and refuses dot segments and missing values', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, json({}));

    await client.request(ENDPOINTS.order, { pathParams: { orderId: 'a/b' } });
    assert.equal(api.single.url.pathname, '/v1/order/a%2Fb');

    await assert.rejects(client.request(ENDPOINTS.order, { pathParams: { orderId: '..' } }), /Invalid value for path parameter "orderId"/);
    await assert.rejects(client.request(ENDPOINTS.order, {}), /Missing path parameter "orderId"/);
    assert.equal(api.requests.length, 1, 'nothing is sent for an invalid path');
  });

  it('serialises the body as JSON with its Content-Type', async () => {
    const { api, client } = setup();
    api.on('POST', '/v1/pipelines/cards', json({ id: 1 }, 201));

    await client.request(ENDPOINTS.createPipelineCard, { body: { contact: { phone: '+380501234567' } } });

    assert.deepEqual(api.single.body, { contact: { phone: '+380501234567' } });
    assert.equal(api.single.headers['content-type'], 'application/json');
  });

  it('returns null for an empty success body', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response(null, { status: 200 }));

    assert.equal(await client.request(ENDPOINTS.orders), null);
  });
});

describe('failures', () => {
  it('turns an error answer into KeycrmApiError with the message of the API', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, json({ message: 'Leads are not enabled' }, 400));

    const error = await client.request(ENDPOINTS.pipelines).catch((e: unknown) => e);

    assert.ok(error instanceof KeycrmApiError);
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Leads are not enabled');
    assert.match(describeError(error), /^KeyCRM API error \(HTTP 400\): Leads are not enabled\nFor pipelines KeyCRM documents this answer/);
  });

  it('lists field errors when the API sends them', async () => {
    const { api, client } = setup();
    api.on(
      'POST',
      /.*/,
      json({ message: 'The given data was invalid.', errors: { 'contact.phone': ['The phone format is invalid.'], title: 'Too long.' } }, 422),
    );

    const error = await client.request(ENDPOINTS.createPipelineCard, { body: {} }).catch((e: unknown) => e);

    assert.equal(
      describeError(error),
      'KeyCRM API error (HTTP 422): The given data was invalid.\n  - contact.phone: The phone format is invalid.\n  - title: Too long.',
    );
  });

  it('explains a rejected key', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, json({ message: 'Unauthenticated.' }, 401));

    const error = await client.request(ENDPOINTS.orders).catch((e: unknown) => e);

    assert.equal(describeError(error), 'KeyCRM API error (HTTP 401): Unauthenticated.\nKeyCRM rejected the API key. Check KEYCRM_API_KEY.');
  });

  it('keeps a truncated text for an error that is not JSON', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response(`<html>${'x'.repeat(2_000)}</html>`, { status: 502 }));

    const error = await client.request(ENDPOINTS.orders).catch((e: unknown) => e);

    assert.ok(error instanceof KeycrmApiError);
    assert.equal(error.message.length, 500);
  });

  it('removes the API key from anything the API echoes back', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, json({ message: `Key ${API_KEY} is blocked`, errors: { key: [`Bearer ${API_KEY}`] } }, 403));

    const text = describeError(await client.request(ENDPOINTS.orders).catch((e: unknown) => e));

    assert.ok(!text.includes(API_KEY));
    assert.match(text, /Key \[redacted\] is blocked/);
    assert.match(text, /key: Bearer \[redacted\]/);
  });

  it('does not follow a redirect and says what to check', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }));

    const error = await client.request(ENDPOINTS.orders).catch((e: unknown) => e);

    assert.ok(error instanceof UnexpectedResponseError);
    assert.match(error.message, /redirect \(HTTP 301\)/);
    assert.match(error.message, /KEYCRM_API_URL/);
    assert.equal(api.requests.length, 1);
  });

  it('reports a success status with a body that is not JSON', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response('<html>ok</html>', { status: 200 }));

    await assert.rejects(client.request(ENDPOINTS.orders), (error: unknown) => {
      assert.ok(error instanceof UnexpectedResponseError);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });

  it('times out instead of waiting forever', async () => {
    const client = new KeycrmClient({ config: testConfig({ timeoutMs: 40 }), fetch: (_url, init) => hang(init) });

    const error = await client.request(ENDPOINTS.orders).catch((e: unknown) => e);

    assert.ok(error instanceof KeycrmTransportError);
    assert.equal(error.kind, 'timeout');
    assert.equal(error.message, 'GET /order timed out after 0.04 s.');
  });

  it('reports a network failure with its cause', async () => {
    const client = new KeycrmClient({
      config: testConfig(),
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      },
    });

    const error = await client.request(ENDPOINTS.orders).catch((e: unknown) => e);

    assert.ok(error instanceof KeycrmTransportError);
    assert.equal(error.kind, 'network');
    assert.match(error.message, /no usable response from https:\/\/openapi\.keycrm\.test \(ENOTFOUND\)/);
  });

  it('never repeats a request on its own, whatever the answer', async () => {
    const { api, client } = setup();
    api.on('POST', /.*/, json({ message: 'Bad gateway' }, 502));

    await assert.rejects(client.request(ENDPOINTS.createPipelineCard, { body: {} }));

    assert.equal(api.requests.length, 1);
  });
});

describe('request pacing', () => {
  it('implements the limit KeyCRM documents: 20 requests per minute', () => {
    assert.deepEqual(RATE_WINDOWS, [{ limit: 20, perMs: 60_000 }]);
  });

  it('lets twenty requests through at once and refuses the next one without sending it', async () => {
    const { api, client, waits } = setup();
    api.on('GET', /.*/, page([]));

    for (let i = 0; i < 20; i += 1) await client.request(ENDPOINTS.orders);
    const error = await client.request(ENDPOINTS.orders).catch((e: unknown) => e);

    assert.ok(error instanceof RateLimitError);
    assert.equal(
      error.message,
      'Not sent: KeyCRM allows 20 requests per minute for one API key, and this server has used that up. Try again in 60 s.',
    );
    assert.deepEqual(waits, []);
    assert.equal(api.requests.length, 20);
  });

  it('waits by itself when the next free moment is a few seconds away', async () => {
    const { api, client, waits, advance } = setup();
    api.on('GET', /.*/, page([]));

    for (let i = 0; i < 20; i += 1) await client.request(ENDPOINTS.orders);
    advance(56_000);
    await client.request(ENDPOINTS.orders);

    assert.deepEqual(waits, [4_000]);
    assert.equal(api.requests.length, 21);
  });

  it('is free again once the minute has passed', async () => {
    const { api, client, waits, advance } = setup();
    api.on('GET', /.*/, page([]));

    for (let i = 0; i < 20; i += 1) await client.request(ENDPOINTS.orders);
    advance(60_000);
    for (let i = 0; i < 20; i += 1) await client.request(ENDPOINTS.orders);

    assert.deepEqual(waits, []);
    assert.equal(api.requests.length, 40);
  });

  it('does not count a refused request against the limit', () => {
    const limiter = new RateLimiter([{ limit: 1, perMs: 60_000 }], () => 0);

    assert.deepEqual(limiter.reserve(5_000), { granted: true, waitMs: 0 });
    assert.deepEqual(limiter.reserve(5_000), { granted: false, waitMs: 60_000 });
    assert.deepEqual(limiter.reserve(5_000), { granted: false, waitMs: 60_000 });
  });
});

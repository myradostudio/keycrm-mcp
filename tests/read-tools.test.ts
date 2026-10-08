/**
 * Read tools, called through a real MCP client. Every request the server sends
 * is checked against the snapshot of the KeyCRM OpenAPI document.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { json, page } from './support/fake-api.js';
import * as fixtures from './support/fixtures.js';
import { IDS } from './support/fixtures.js';
import { createHarness, type Harness } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** The single request of the test, already checked against the spec. */
function sent(h: Harness) {
  const request = h.api.single;
  return { request, operation: assertMatchesSpec(request), params: request.url.searchParams };
}

describe('list_orders', () => {
  it('lists orders as compact summaries with a pagination block', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', page([fixtures.order], { total: 31, next_page_url: 'https://openapi.keycrm.app/v1/order?page=2' }));

    const result = await harness.callJson('list_orders');

    const { operation, params } = sent(harness);
    assert.equal(operation, 'GET /order');
    assert.deepEqual([...params.entries()], [['limit', '15'], ['page', '1']]);
    assert.deepEqual(result, {
      pagination: { page: 1, limit: 15, returned: 1, total: 31, next_page: 2 },
      results: [
        {
          id: IDS.order,
          source_uuid: 'SHOP-1024',
          source_id: IDS.source,
          status_id: IDS.status,
          status_group_id: 2,
          grand_total: 1350.5,
          total_discount: 50,
          shipping_price: 90,
          payment_status: 'paid',
          manager_comment: 'Передзвонити після 14:00',
          ordered_at: '2026-10-07 08:14:30',
          created_at: '2026-10-07 08:15:00',
          updated_at: '2026-10-07 10:00:00',
        },
      ],
    });
  });

  it('sends every filter in the form the document shows', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', page([]));

    await harness.callJson('list_orders', {
      status_ids: [1, 4],
      source_ids: [IDS.source],
      source_order_id: 'SHOP-1024',
      buyer_phone: '+380501234567',
      buyer_email: 'iryna@example.com',
      payment_statuses: ['paid', 'overpaid'],
      has_tracking_code: true,
      created_from: '2026-10-01T00:00:00+03:00',
      created_to: '2026-10-07T23:59:59+03:00',
      updated_from: '2026-10-07T00:00:00Z',
      updated_to: '2026-10-07T12:00:00Z',
      shipping_from: '2026-10-08T00:00:00+03:00',
      shipping_to: '2026-10-09T00:00:00+03:00',
      include: ['buyer', 'status', 'products.offer'],
      sort: 'newest',
      limit: 50,
      page: 3,
    });

    const { params } = sent(harness);
    assert.deepEqual(Object.fromEntries(params), {
      limit: '50',
      page: '3',
      include: 'buyer,status,products.offer',
      sort: '-id',
      'filter[status_id]': '1,4',
      'filter[source_id]': String(IDS.source),
      'filter[source_uuid]': 'SHOP-1024',
      'filter[buyer_phone]': '+380501234567',
      'filter[buyer_email]': 'iryna@example.com',
      'filter[payment_status]': 'paid,overpaid',
      'filter[has_tracking_code]': 'true',
      // Kyiv summer time is UTC+3: the server converts to UTC, which is what KeyCRM filters by.
      'filter[created_between]': '2026-09-30 21:00:00,2026-10-07 20:59:59',
      'filter[updated_between]': '2026-10-07 00:00:00,2026-10-07 12:00:00',
      'filter[shipping_between]': '2026-10-07 21:00:00,2026-10-08 21:00:00',
    });
  });

  it('keeps what was asked for with include, in compact form', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', page([fixtures.orderWithIncludes]));

    const { results } = await harness.callJson('list_orders', { include: ['buyer', 'status', 'manager', 'products.offer', 'payments', 'shipping.deliveryService', 'tags'] });

    assertMatchesSpec(harness.api.single);
    const [order] = results;
    assert.deepEqual(order.buyer, { id: IDS.buyer, full_name: 'Ірина Тестова', phone: '+380501234567', email: 'iryna@example.com' });
    assert.deepEqual(order.status, { id: IDS.status, name: 'Відправлено' });
    assert.deepEqual(order.manager, { id: IDS.manager, full_name: 'Олег Тестовий' });
    assert.deepEqual(order.products, [{ name: 'Чашка керамічна', sku: 'CUP-01', price_sold: 420.5, price: 450.5, quantity: 3 }]);
    assert.deepEqual(order.payments, [
      { id: 900, amount: 1350.5, actual_currency: 'UAH', status: 'paid', payment_method_id: 1, payment_date: '2026-10-07 08:20:00' },
    ]);
    assert.deepEqual(order.shipping, {
      delivery_service_id: 1,
      tracking_code: '20450000000000',
      shipping_status: 'sent',
      shipping_address_city: 'Київ',
      shipping_receive_point: 'Відділення №1',
      recipient_full_name: 'Ірина Тестова',
      recipient_phone: '+380501234567',
    });
    assert.deepEqual(order.tags, [{ id: 3, name: 'VIP' }]);
  });

  it('sorts oldest first on request and sends false for orders without a tracking code', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', page([]));

    await harness.callJson('list_orders', { sort: 'oldest', has_tracking_code: false });

    const { params } = sent(harness);
    assert.equal(params.get('sort'), 'id');
    assert.equal(params.get('filter[has_tracking_code]'), 'false');
  });

  it('clamps the page size to the maximum of the API', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', page([]));

    const result = await harness.callJson('list_orders', { limit: 500 });

    assert.equal(sent(harness).params.get('limit'), '50');
    assert.equal(result.pagination.limit, 50);
  });

  it('says there is no next page when KeyCRM gives no next_page_url', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', page([fixtures.order], { total: 1, next_page_url: null }));

    const result = await harness.callJson('list_orders');

    assert.equal(result.pagination.next_page, null);
  });

  it('derives the next page from a full page when the field is missing', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', json({ total: 9, data: [fixtures.order, fixtures.order] }));

    const full = await harness.callJson('list_orders', { limit: 2 });
    const partial = await harness.callJson('list_orders', { limit: 5 });

    assert.equal(full.pagination.next_page, 2);
    assert.equal(partial.pagination.next_page, null);
  });

  it('wants both ends of a period, in order', async () => {
    harness = await createHarness();

    const half = await harness.call('list_orders', { created_from: '2026-10-01T00:00:00+03:00' });
    const reversed = await harness.call('list_orders', { updated_from: '2026-10-07T00:00:00Z', updated_to: '2026-10-01T00:00:00Z' });

    assert.equal(half.isError, true);
    assert.match(half.text, /created_from and created_to must be given together/);
    assert.match(reversed.text, /updated_from must not be later than updated_to/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('rejects what it cannot pass on faithfully', async () => {
    harness = await createHarness();
    const invalid: Record<string, unknown>[] = [
      { status: 'new' },
      { include: ['customer'] },
      { payment_statuses: ['refunded'] },
      { created_from: '2026-10-01', created_to: '2026-10-07' },
      { buyer_phone: '+380501234567,+380671234567' },
      { status_ids: [] },
      { limit: 0 },
      { page: 0 },
    ];

    for (const args of invalid) {
      const result = await harness.call('list_orders', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(harness.api.requests.length, 0);
  });

  it('reports an answer that is not a list', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', json({ message: 'ok' }));

    const result = await harness.call('list_orders');

    assert.equal(result.isError, true);
    assert.match(result.text, /a paginated list was expected/);
  });
});

describe('get_order', () => {
  it('returns the order as KeyCRM sent it', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/order/${IDS.order}`, json(fixtures.orderWithIncludes));

    const result = await harness.callJson('get_order', { order_id: IDS.order, include: ['buyer', 'payments'] });

    const { operation, params } = sent(harness);
    assert.equal(operation, 'GET /order/{orderId}');
    assert.deepEqual([...params.entries()], [['include', 'buyer,payments']]);
    assert.deepEqual(result, fixtures.orderWithIncludes);
  });

  it('includes nothing unless asked', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/order/${IDS.order}`, json(fixtures.order));

    await harness.callJson('get_order', { order_id: IDS.order });

    assert.equal(sent(harness).request.url.search, '');
  });

  it('passes "not found" on with a hint', async () => {
    harness = await createHarness();
    harness.api.on('GET', /\/v1\/order\/\d+/, json({ message: 'Not found' }, 404));

    const result = await harness.call('get_order', { order_id: 999 });

    assert.equal(result.isError, true);
    assert.equal(result.text, 'KeyCRM API error (HTTP 404): Not found\nKeyCRM did not find an object with this id.');
  });

  it('wants a numeric id', async () => {
    harness = await createHarness();

    const result = await harness.call('get_order', { order_id: 'SHOP-1024' });

    assert.equal(result.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('order dictionaries', () => {
  it('list_order_statuses returns the statuses used to read and filter orders', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order/status', page([fixtures.orderStatus]));

    const result = await harness.callJson('list_order_statuses', { limit: 50 });

    assert.equal(sent(harness).operation, 'GET /order/status');
    assert.deepEqual(result.results, [
      { id: IDS.status, name: 'Відправлено', alias: 'sent', group_id: 2, is_active: true, is_closing_order: false },
    ]);
  });

  it('list_order_sources returns the sources with their currency', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order/source', page([fixtures.source]));

    const result = await harness.callJson('list_order_sources');

    assert.equal(sent(harness).operation, 'GET /order/source');
    assert.deepEqual(result.results, [{ id: IDS.source, name: 'Інтернет-магазин', alias: 'shop', driver: 'opencart', currency_code: 'UAH' }]);
  });
});

describe('buyers', () => {
  it('list_buyers finds a buyer by phone', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/buyer', page([fixtures.buyer]));

    const result = await harness.callJson('list_buyers', { buyer_phone: '+380501234567' });

    const { operation, params } = sent(harness);
    assert.equal(operation, 'GET /buyer');
    assert.equal(params.get('filter[buyer_phone]'), '+380501234567');
    assert.deepEqual(result.results, [
      {
        id: IDS.buyer,
        full_name: 'Ірина Тестова',
        phone: ['+380501234567'],
        email: ['iryna@example.com'],
        note: 'Постійна клієнтка',
        created_at: '2026-03-01 12:00:00',
        updated_at: '2026-10-07 08:15:00',
      },
    ]);
  });

  it('list_buyers sends ids, e-mail, periods and includes', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/buyer', page([fixtures.buyerWithIncludes]));

    const result = await harness.callJson('list_buyers', {
      buyer_ids: [IDS.buyer, 311],
      buyer_email: 'iryna@example.com',
      created_from: '2026-03-01T00:00:00+02:00',
      created_to: '2026-03-31T23:59:59+03:00',
      updated_from: '2026-10-01T00:00:00Z',
      updated_to: '2026-10-08T00:00:00Z',
      include: ['company', 'manager'],
    });

    const { params } = sent(harness);
    assert.equal(params.get('filter[buyer_id]'), `${IDS.buyer},311`);
    assert.equal(params.get('filter[buyer_email]'), 'iryna@example.com');
    assert.equal(params.get('filter[created_between]'), '2026-02-28 22:00:00,2026-03-31 20:59:59');
    assert.equal(params.get('filter[updated_between]'), '2026-10-01 00:00:00,2026-10-08 00:00:00');
    assert.equal(params.get('include'), 'company,manager');
    assert.deepEqual(result.results[0].company, { id: 20, name: 'ТОВ «Приклад»' });
    assert.deepEqual(result.results[0].manager, { id: IDS.manager, full_name: 'Олег Тестовий' });
    assert.equal(result.results[0].shipping, undefined, 'addresses are for get_buyer');
  });

  it('get_buyer returns the full record', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/buyer/${IDS.buyer}`, json(fixtures.buyerWithIncludes));

    const result = await harness.callJson('get_buyer', { buyer_id: IDS.buyer, include: ['shipping', 'company', 'manager'] });

    const { operation, params } = sent(harness);
    assert.equal(operation, 'GET /buyer/{buyerId}');
    assert.equal(params.get('include'), 'shipping,company,manager');
    assert.deepEqual(result, fixtures.buyerWithIncludes);
  });

  it('refuses an include that belongs to orders', async () => {
    harness = await createHarness();

    const result = await harness.call('get_buyer', { buyer_id: IDS.buyer, include: ['payments'] });

    assert.equal(result.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('pipelines', () => {
  it('list_pipelines returns the boards', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/pipelines', page([fixtures.pipeline]));

    const result = await harness.callJson('list_pipelines');

    assert.equal(sent(harness).operation, 'GET /pipelines');
    assert.deepEqual(result.results, [{ id: IDS.pipeline, name: 'Заявки із сайту', lead_type: 'lead', use_payments: false }]);
  });

  it('explains the answer of an account where pipelines are switched off', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/pipelines', json({ message: 'Leads are not enabled' }, 400));

    const result = await harness.call('list_pipelines');

    assert.equal(result.isError, true);
    assert.match(result.text, /^KeyCRM API error \(HTTP 400\): Leads are not enabled\n.*switched off in the CRM settings/);
  });

  it('list_pipeline_statuses returns the stages of one pipeline', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/pipelines/${IDS.pipeline}/statuses`, page([fixtures.pipelineStatus]));

    const result = await harness.callJson('list_pipeline_statuses', { pipeline_id: IDS.pipeline });

    assert.equal(sent(harness).operation, 'GET /pipelines/{pipelineId}/statuses');
    assert.deepEqual(result.results, [
      { id: IDS.pipelineStatus, pipeline_id: IDS.pipeline, title: 'Нова заявка', alias: 'new', is_final: false, leads_count: 5 },
    ]);
  });

  it('list_pipeline_cards filters by pipeline, stage, source and period', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/pipelines/cards', page([fixtures.cardWithIncludes]));

    const result = await harness.callJson('list_pipeline_cards', {
      pipeline_id: IDS.pipeline,
      status_ids: [IDS.pipelineStatus, 13],
      source_ids: [IDS.source],
      created_from: '2026-10-08T00:00:00+03:00',
      created_to: '2026-10-08T23:59:59+03:00',
      include: ['contact.client', 'status', 'manager'],
    });

    const { operation, params } = sent(harness);
    assert.equal(operation, 'GET /pipelines/cards');
    assert.equal(params.get('filter[pipeline_id]'), String(IDS.pipeline));
    assert.equal(params.get('filter[status_id]'), `${IDS.pipelineStatus},13`);
    assert.equal(params.get('filter[source_id]'), String(IDS.source));
    assert.equal(params.get('filter[created_between]'), '2026-10-07 21:00:00,2026-10-08 20:59:59');
    assert.equal(params.get('include'), 'contact.client,status,manager');
    assert.deepEqual(result.results, [
      {
        id: IDS.card,
        title: 'Заявка: консультація',
        status_id: IDS.pipelineStatus,
        source_id: IDS.source,
        manager_id: IDS.manager,
        contact_id: IDS.contact,
        manager_comment: 'Просить передзвонити зранку',
        is_finished: false,
        communicate_at: '2026-10-09 07:00:00',
        status_changed_at: '2026-10-08 07:00:00',
        created_at: '2026-10-08 07:00:00',
        updated_at: '2026-10-08 07:00:00',
        contact: { id: IDS.contact, full_name: 'Ірина Тестова', phone: '+380501234567', email: 'iryna@example.com', client_id: IDS.buyer },
        status: { id: IDS.pipelineStatus, name: 'Нова заявка', pipeline_id: IDS.pipeline },
        manager: { id: IDS.manager, full_name: 'Олег Тестовий' },
      },
    ]);
  });

  it('get_pipeline_card unwraps the list KeyCRM documents for a single card', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/pipelines/cards/${IDS.card}`, page([fixtures.cardWithIncludes]));

    const result = await harness.callJson('get_pipeline_card', { card_id: IDS.card, include: ['contact.client'] });

    const { operation, params } = sent(harness);
    assert.equal(operation, 'GET /pipelines/cards/{cardId}');
    assert.equal(params.get('include'), 'contact.client');
    assert.deepEqual(result, fixtures.cardWithIncludes);
  });

  it('get_pipeline_card accepts a bare object too', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/pipelines/cards/${IDS.card}`, json(fixtures.card));

    assert.deepEqual(await harness.callJson('get_pipeline_card', { card_id: IDS.card }), fixtures.card);
  });

  it('get_pipeline_card says so when the list comes back empty', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/v1/pipelines/cards/${IDS.card}`, page([]));

    const result = await harness.call('get_pipeline_card', { card_id: IDS.card });

    assert.equal(result.isError, true);
    assert.equal(result.text, 'KeyCRM returned no pipeline card for this id.');
  });
});

describe('list_users', () => {
  it('lists managers without their phones and login times', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/users', page([fixtures.user]));

    const result = await harness.callJson('list_users');

    assert.equal(sent(harness).operation, 'GET /users');
    assert.deepEqual(result.results, [
      { id: IDS.manager, full_name: 'Олег Тестовий', username: 'oleg', email: 'oleg@example.com', role_id: 1, status: 'active' },
    ]);
  });
});

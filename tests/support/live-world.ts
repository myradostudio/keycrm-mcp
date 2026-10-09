/**
 * A stand-in for the KeyCRM API that keeps a small account consistent enough
 * for the live check to pass: six orders of two buyers, two pipelines with their
 * stages and four cards. Unlike the canned answers of the other tests it applies
 * the filters, the sorting, the paging and the `include` it is sent, because
 * that is what the live check verifies.
 *
 * Every name, number and phone here is made up, as in fixtures.ts.
 */

import { FakeApi, json, type RecordedRequest } from './fake-api.js';
import * as fixtures from './fixtures.js';
import { IDS } from './fixtures.js';

const BASE = '/v1';
export const OTHER = { status: 5, source: 3, pipeline: 4, stage: 20, buyer: 311 } as const;

type Json = Record<string, any>;

export interface WorldOptions {
  /** No orders, buyers or cards: an account that was just opened. */
  readonly empty?: boolean;
  /** Filters the stand-in takes and does not apply, as an API that ignores them. */
  readonly ignoredFilters?: readonly string[];
  /** Filters that find nothing, as an API that stores the value in another form than it is asked in. */
  readonly unmatchedFilters?: readonly string[];
  /** The stand-in puts every new card into the first pipeline, whatever was asked for. */
  readonly ignoresPipelineOfNewCard?: boolean;
  /** A list filtered by a phone or an e-mail is refused, and the refusal repeats the value. */
  readonly refusesContactFilters?: boolean;
  /** Buyers and cards, but no orders: the live check then takes its buyer from the list of buyers. */
  readonly withoutOrders?: boolean;
}

export interface World {
  readonly api: FakeApi;
  /** The cards of the account, the ones created during the run included. */
  readonly cards: Json[];
}

const BUYERS: readonly Json[] = [
  fixtures.buyer,
  {
    ...fixtures.buyer,
    id: OTHER.buyer,
    full_name: 'Петро Тестовий',
    email: ['petro@example.com'],
    phone: ['+380671234567'],
    created_at: '2026-04-02 09:00:00',
    updated_at: '2026-10-06 11:30:00',
  },
];

/**
 * Source, status, payment and tracking code of the six orders. The last order is the newest, the one the live check
 * takes its values from; each of the four before it differs from it in exactly one of the four, so that a filter the
 * stand-in is told to ignore lets exactly one foreign order through.
 */
const ORDER_KINDS: readonly (readonly [source: number, status: number, paid: boolean, tracked: boolean])[] = [
  [IDS.source, IDS.status, true, true],
  [OTHER.source, OTHER.status, false, true],
  [IDS.source, OTHER.status, false, false],
  [OTHER.source, IDS.status, false, false],
  [OTHER.source, OTHER.status, true, false],
  [OTHER.source, OTHER.status, false, false],
];

const ORDERS: readonly Json[] = ORDER_KINDS.map(([source, status, paid, tracked], index) => {
  const day = `2026-10-0${index + 1}`;
  return {
    ...fixtures.order,
    id: IDS.order + index,
    source_uuid: `SHOP-${1024 + index}`,
    source_id: source,
    status_id: status,
    payment_status: paid ? 'paid' : 'not_paid',
    created_at: `${day} 08:15:00`,
    ordered_at: `${day} 08:14:30`,
    updated_at: `${day} 10:00:00`,
    // Not fields of the API: what the associations are built from.
    $buyer: BUYERS[index % 2],
    $tracking: tracked ? `2045000000000${index}` : null,
    $shipped: `${day} 12:00:00`,
  };
});

const STAGES: readonly Json[] = [
  fixtures.pipelineStatus,
  { ...fixtures.pipelineStatus, id: 13, title: 'У роботі', alias: 'in_work', leads_count: 2 },
  { ...fixtures.pipelineStatus, id: OTHER.stage, pipeline_id: OTHER.pipeline, title: 'Новий запит', leads_count: 1 },
];
const PIPELINES: readonly Json[] = [fixtures.pipeline, { ...fixtures.pipeline, id: OTHER.pipeline, name: 'Оптові запити' }];

const CARDS: readonly Json[] = [IDS.pipelineStatus, 13, OTHER.stage, IDS.pipelineStatus].map((stage, index) => ({
  ...fixtures.card,
  id: IDS.card + index,
  status_id: stage,
  source_id: index < 2 ? IDS.source : OTHER.source,
  created_at: `2026-10-0${index + 3} 07:00:00`,
  updated_at: `2026-10-0${index + 3} 09:30:00`,
  $contact: fixtures.cardWithIncludes.contact,
}));

/** Drops the helper fields that begin with `$`: the API does not send them. */
const published = (record: Json): Json => Object.fromEntries(Object.entries(record).filter(([name]) => !name.startsWith('$')));
const pipelineOf = (stageId: unknown) => STAGES.find((stage) => stage['id'] === stageId)?.['pipeline_id'];
const included = (url: URL) => (url.searchParams.get('include') ?? '').split(',').filter(Boolean);
const notFound = () => json({ message: 'Not found' }, 404);
const idIn = (url: URL) => Number(url.pathname.split('/').at(-1));

function orderView(order: Json, include: readonly string[]): Json {
  const buyer = order['$buyer'];
  const full = fixtures.orderWithIncludes;
  return {
    ...published(order),
    ...(include.includes('buyer') ? { buyer: { ...full.buyer, id: buyer.id, full_name: buyer.full_name, email: buyer.email[0], phone: buyer.phone[0] } } : {}),
    ...(include.includes('status') ? { status: { ...full.status, id: order['status_id'] } } : {}),
    ...(include.includes('manager') ? { manager: full.manager } : {}),
    ...(include.includes('products.offer') ? { products: full.products } : {}),
    ...(include.includes('payments') ? { payments: full.payments } : {}),
    ...(include.some((item) => item.startsWith('shipping.')) ? { shipping: { ...full.shipping, tracking_code: order['$tracking'] } } : {}),
    ...(include.includes('tags') ? { tags: full.tags } : {}),
  };
}

function buyerView(buyer: Json, include: readonly string[]): Json {
  const full = fixtures.buyerWithIncludes;
  return {
    ...buyer,
    ...(include.includes('company') ? { company: full.company } : {}),
    ...(include.includes('manager') ? { manager: full.manager } : {}),
    ...(include.includes('shipping') ? { shipping: full.shipping } : {}),
  };
}

function cardView(card: Json, include: readonly string[]): Json {
  const full = fixtures.cardWithIncludes;
  return {
    ...published(card),
    ...(include.includes('contact.client') ? { contact: card['$contact'] } : {}),
    ...(include.includes('status') ? { status: { ...full.status, id: card['status_id'], pipeline_id: pipelineOf(card['status_id']) } } : {}),
    ...(include.includes('manager') && card['manager_id'] !== null ? { manager: full.manager } : {}),
  };
}

export function liveWorld(options: WorldOptions = {}): World {
  const api = new FakeApi();
  const orders = options.empty === true || options.withoutOrders === true ? [] : ORDERS;
  const buyers = options.empty === true ? [] : BUYERS;
  const cards: Json[] = options.empty === true ? [] : CARDS.map((card) => ({ ...card }));

  /** The value of `filter[name]`, unless the stand-in was told to ignore that filter. */
  const filter = (url: URL, name: string) => (options.ignoredFilters?.includes(name) === true ? null : url.searchParams.get(`filter[${name}]`));
  const matches = (url: URL, name: string, test: (asked: string) => boolean) => {
    const asked = filter(url, name);
    if (asked === null) return true;
    return options.unmatchedFilters?.includes(name) === true ? false : test(asked);
  };
  const among = (url: URL, name: string, actual: unknown) => matches(url, name, (asked) => asked.split(',').includes(String(actual)));
  /** `from,to` in the form KeyCRM writes moments in, which also sorts as text. */
  const between = (url: URL, name: string, actual: string) =>
    matches(url, name, (asked) => {
      const [from = '', to = ''] = asked.split(',');
      return actual >= from && actual <= to;
    });

  const contactRefusal = ({ searchParams }: URL) => {
    const contact = searchParams.get('filter[buyer_phone]') ?? searchParams.get('filter[buyer_email]');
    return options.refusesContactFilters === true && contact !== null ? json({ message: `Nothing is found for ${contact}` }, 422) : undefined;
  };

  /** The paginated envelope of the document, with the page that was asked for. */
  const listed = ({ url }: RecordedRequest, records: readonly Json[]) => {
    const limit = Number(url.searchParams.get('limit') ?? 15);
    const page = Number(url.searchParams.get('page') ?? 1);
    const sort = url.searchParams.get('sort');
    const sorted = sort === null ? records : [...records].sort((a, b) => (sort === '-id' ? b['id'] - a['id'] : a['id'] - b['id']));
    return json({
      total: sorted.length,
      current_page: page,
      per_page: limit,
      data: sorted.slice((page - 1) * limit, page * limit),
      next_page_url: page * limit < sorted.length ? `https://openapi.keycrm.app${url.pathname}?page=${page + 1}` : null,
    });
  };

  api.on('GET', `${BASE}/order/status`, (request) => listed(request, [fixtures.orderStatus, { ...fixtures.orderStatus, id: OTHER.status, name: 'Нове', alias: 'new' }]));
  api.on('GET', `${BASE}/order/source`, (request) => listed(request, [fixtures.source, { ...fixtures.source, id: OTHER.source, name: 'Маркетплейс', alias: 'market' }]));
  api.on('GET', `${BASE}/users`, (request) =>
    listed(request, [fixtures.user, { ...fixtures.user, id: 8, full_name: 'Марія Тестова', username: 'maria', email: 'maria@example.com' }]),
  );

  api.on('GET', `${BASE}/order`, (request) => {
    const { url } = request;
    const refused = contactRefusal(url);
    if (refused !== undefined) return refused;
    const found = orders.filter(
      (order) =>
        among(url, 'status_id', order['status_id']) &&
        among(url, 'source_id', order['source_id']) &&
        among(url, 'source_uuid', order['source_uuid']) &&
        among(url, 'payment_status', order['payment_status']) &&
        matches(url, 'buyer_phone', (asked) => order['$buyer'].phone.includes(asked)) &&
        matches(url, 'buyer_email', (asked) => order['$buyer'].email.includes(asked)) &&
        matches(url, 'has_tracking_code', (asked) => String(order['$tracking'] !== null) === asked) &&
        between(url, 'created_between', order['created_at']) &&
        between(url, 'updated_between', order['updated_at']) &&
        between(url, 'shipping_between', order['$shipped']),
    );
    return listed(request, found.map((order) => orderView(order, included(url))));
  });
  api.on('GET', new RegExp(`^${BASE}/order/\\d+$`), ({ url }) => {
    const order = orders.find((candidate) => candidate['id'] === idIn(url));
    return order === undefined ? notFound() : json(orderView(order, included(url)));
  });

  api.on('GET', `${BASE}/buyer`, (request) => {
    const { url } = request;
    const refused = contactRefusal(url);
    if (refused !== undefined) return refused;
    const found = buyers.filter(
      (buyer) =>
        among(url, 'buyer_id', buyer['id']) &&
        matches(url, 'buyer_phone', (asked) => buyer['phone'].includes(asked)) &&
        matches(url, 'buyer_email', (asked) => buyer['email'].includes(asked)) &&
        between(url, 'created_between', buyer['created_at']) &&
        between(url, 'updated_between', buyer['updated_at']),
    );
    return listed(request, found.map((buyer) => buyerView(buyer, included(url))));
  });
  api.on('GET', new RegExp(`^${BASE}/buyer/\\d+$`), ({ url }) => {
    const buyer = buyers.find((candidate) => candidate['id'] === idIn(url));
    return buyer === undefined ? notFound() : json(buyerView(buyer, included(url)));
  });

  api.on('GET', `${BASE}/pipelines`, (request) => listed(request, PIPELINES));
  api.on('GET', new RegExp(`^${BASE}/pipelines/\\d+/statuses$`), (request) => {
    const pipelineId = Number(request.url.pathname.split('/').at(-2));
    return listed(request, STAGES.filter((stage) => stage['pipeline_id'] === pipelineId));
  });

  api.on('GET', `${BASE}/pipelines/cards`, (request) => {
    const { url } = request;
    const found = cards.filter(
      (card) =>
        among(url, 'pipeline_id', pipelineOf(card['status_id'])) &&
        among(url, 'status_id', card['status_id']) &&
        among(url, 'source_id', card['source_id']) &&
        between(url, 'created_between', card['created_at']) &&
        between(url, 'updated_between', card['updated_at']),
    );
    return listed(request, found.map((card) => cardView(card, included(url))));
  });
  api.on('GET', new RegExp(`^${BASE}/pipelines/cards/\\d+$`), (request) => {
    const card = cards.find((candidate) => candidate['id'] === idIn(request.url));
    // The document describes the answer for one card as a paginated list.
    return card === undefined ? notFound() : listed(request, [cardView(card, included(request.url))]);
  });

  api.on('POST', `${BASE}/pipelines/cards`, ({ body }) => {
    const sent = body as Json;
    const pipelineId = options.ignoresPipelineOfNewCard === true ? IDS.pipeline : (sent['pipeline_id'] ?? IDS.pipeline);
    const stage = STAGES.find((candidate) => candidate['pipeline_id'] === pipelineId);
    if (stage === undefined) return json({ message: 'Wrong arguments or pipelines are not activated' }, 403);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const id = IDS.card + cards.length;
    const card: Json = {
      id,
      contact_id: IDS.contact + cards.length,
      source_id: sent['source_id'] ?? null,
      manager_id: sent['manager_id'] ?? null,
      status_id: stage['id'],
      title: sent['title'] ?? String(id),
      manager_comment: sent['manager_comment'] ?? null,
      is_finished: false,
      status_changed_at: now,
      communicate_at: sent['communicate_at'] ?? null,
      utm_source: sent['utm_source'] ?? null,
      utm_medium: sent['utm_medium'] ?? null,
      utm_campaign: sent['utm_campaign'] ?? null,
      utm_term: sent['utm_term'] ?? null,
      utm_content: sent['utm_content'] ?? null,
      created_at: now,
      updated_at: now,
      $contact: { id: IDS.contact + cards.length, full_name: null, email: null, phone: null, client_id: null, ...sent['contact'] },
    };
    cards.push(card);
    return json(published(card), 201);
  });

  return { api, cards };
}

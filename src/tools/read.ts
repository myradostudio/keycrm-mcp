/**
 * Read-only tools. They only issue GET requests and are always registered.
 *
 * Input schemas are strict: an argument the tool does not know is rejected
 * instead of ignored, so the model never believes it applied a filter that was
 * silently dropped. The filters offered are exactly the ones the OpenAPI
 * document shows for each list.
 *
 * KeyCRM stores and returns every moment in UTC.
 */

import { z } from 'zod';

import { ENDPOINTS } from '../endpoints.js';
import { ToolError } from '../errors.js';
import {
  between,
  dateTime,
  filterText,
  id,
  idList,
  include,
  isObject,
  joined,
  limit,
  objects,
  page,
  paginated,
  resolvePage,
} from './schemas.js';
import {
  summarizeBuyer,
  summarizeCard,
  summarizeOrder,
  summarizeOrderStatus,
  summarizePipeline,
  summarizePipelineStatus,
  summarizeSource,
  summarizeUser,
} from './summaries.js';
import { defineTool, READ_ONLY, type AnyTool } from './types.js';

// "Allowed associations" as listed in the `include` parameter of each operation.
export const ORDER_INCLUDES = [
  'buyer',
  'products.offer',
  'manager',
  'tags',
  'status',
  'marketing',
  'payments',
  'shipping.lastHistory',
  'shipping.deliveryService',
  'expenses',
  'custom_fields',
  'assigned',
] as const;
export const BUYER_INCLUDES = ['manager', 'shipping', 'company', 'loyalty', 'custom_fields'] as const;
export const CARD_INCLUDES = ['contact.client', 'products', 'manager', 'status', 'payments', 'custom_fields'] as const;

const PAYMENT_STATUSES = ['not_paid', 'part_paid', 'paid', 'overpaid'] as const;

const orderInclude = include(
  ORDER_INCLUDES,
  'Useful ones: "buyer" (name and contacts), "status" (status name), "products.offer" (order lines), "payments", "shipping.deliveryService" (delivery and tracking code).',
);
const buyerInclude = include(BUYER_INCLUDES, '"shipping" adds delivery addresses, "company" and "manager" add the linked records.');
const cardInclude = include(
  CARD_INCLUDES,
  '"contact.client" adds the contact person with the linked buyer, "status" the stage name, "manager" the responsible user.',
);

const sort = z
  .enum(['newest', 'oldest'])
  .optional()
  .describe('Order by id: "newest" first or "oldest" first. Omit to keep the order of the API.');

function sortValue(value: 'newest' | 'oldest' | undefined): string | undefined {
  return value === undefined ? undefined : value === 'newest' ? '-id' : 'id';
}

/** `GET /pipelines/cards/{cardId}` is documented as a paginated list; a bare object is accepted as well. */
function singleRecord(response: unknown, what: string): Record<string, unknown> {
  if (isObject(response) && Array.isArray(response['data'])) {
    const [first] = objects(response['data']);
    if (first === undefined) throw new ToolError(`KeyCRM returned no ${what} for this id.`);
    return first;
  }
  if (!isObject(response)) throw new ToolError(`Unexpected response from the KeyCRM API: a ${what} was expected.`);
  return response;
}

export const readTools: readonly AnyTool[] = [
  defineTool({
    name: 'list_orders',
    title: 'List orders',
    description:
      'Lists orders with their total (grand_total, in the currency of the source), payment status, status id, source id, comments and dates, newest or oldest first. Filters: status, source, the order id in the source system, buyer phone or e-mail, payment status, whether a tracking code is set, and periods of creation, update and shipping. Buyer, status name, products, payments and shipping are returned only when asked for with `include`. All dates are UTC. Use get_order for the complete record.',
    access: 'read',
    inputSchema: z.strictObject({
      status_ids: idList('Only orders in these statuses (ids from list_order_statuses)'),
      source_ids: idList('Only orders from these sources (ids from list_order_sources)'),
      source_order_id: filterText('Only the order with this id in the source system (source_uuid), e.g. the order number of the shop.').optional(),
      buyer_phone: filterText('Only orders of the buyer with this phone, as it is stored in KeyCRM, e.g. +380501234567.').optional(),
      buyer_email: filterText('Only orders of the buyer with this e-mail.').optional(),
      payment_statuses: z.array(z.enum(PAYMENT_STATUSES)).min(1).optional().describe('Only orders in these payment statuses.'),
      has_tracking_code: z.boolean().optional().describe('true: only orders with a tracking code; false: only orders without one.'),
      created_from: dateTime('Only orders created from this moment (requires created_to).').optional(),
      created_to: dateTime('Only orders created up to this moment (requires created_from).').optional(),
      updated_from: dateTime('Only orders changed from this moment (requires updated_to).').optional(),
      updated_to: dateTime('Only orders changed up to this moment (requires updated_from).').optional(),
      shipping_from: dateTime('Only orders with a shipping date from this moment (requires shipping_to).').optional(),
      shipping_to: dateTime('Only orders with a shipping date up to this moment (requires shipping_from).').optional(),
      include: orderInclude,
      sort,
      limit,
      page,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.orders, {
        query: { ...requested, include: joined(args.include), sort: sortValue(args.sort) },
        filter: {
          status_id: joined(args.status_ids),
          source_id: joined(args.source_ids),
          source_uuid: args.source_order_id,
          buyer_phone: args.buyer_phone,
          buyer_email: args.buyer_email,
          payment_status: joined(args.payment_statuses),
          has_tracking_code: args.has_tracking_code === undefined ? undefined : String(args.has_tracking_code),
          created_between: between(args.created_from, args.created_to, 'created'),
          updated_between: between(args.updated_from, args.updated_to, 'updated'),
          shipping_between: between(args.shipping_from, args.shipping_to, 'shipping'),
        },
      });
      return { data: paginated(response, requested, summarizeOrder) };
    },
  }),

  defineTool({
    name: 'get_order',
    title: 'Get an order',
    description:
      'Returns one order in full: totals, discount, shipping price, taxes, margin, comments, payment status and dates (UTC). Related data comes only when asked for with `include`: the buyer with contacts, order lines with catalogue records, payments, shipping with the delivery service and tracking code, the manager, tags, UTM marks, expenses and custom fields. The result can contain customer contact data and a delivery address.',
    access: 'read',
    inputSchema: z.strictObject({
      order_id: id('Order id in KeyCRM'),
      include: orderInclude,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => ({
      data: await client.request(ENDPOINTS.order, {
        pathParams: { orderId: args.order_id },
        query: { include: joined(args.include) },
      }),
    }),
  }),

  defineTool({
    name: 'list_order_statuses',
    title: 'List order statuses',
    description:
      'Lists the active order statuses of the account: id, name, system name (alias), status group and whether the status closes an order. Use the ids to filter list_orders and to read status_id in its results.',
    access: 'read',
    inputSchema: z.strictObject({ limit, page }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.orderStatuses, { query: { ...requested } });
      return { data: paginated(response, requested, summarizeOrderStatus) };
    },
  }),

  defineTool({
    name: 'list_order_sources',
    title: 'List order sources',
    description:
      'Lists the sources orders and leads come from (shops, marketplaces, forms): id, name, system name, integration type (driver) and currency. Use the ids to filter list_orders and list_pipeline_cards, and as source_id of a new pipeline card.',
    access: 'read',
    inputSchema: z.strictObject({ limit, page }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.orderSources, { query: { ...requested } });
      return { data: paginated(response, requested, summarizeSource) };
    },
  }),

  defineTool({
    name: 'list_buyers',
    title: 'List buyers',
    description:
      'Lists buyers (customers) with name, phones, e-mails, birthday, note and dates (UTC). Filters: buyer ids, phone, e-mail, and periods of creation and update. Search by phone or e-mail to find out whether a person is already in the CRM. The linked company and manager are returned only when asked for with `include`. Use get_buyer for the complete record.',
    access: 'read',
    inputSchema: z.strictObject({
      buyer_ids: idList('Only these buyers'),
      buyer_phone: filterText('Only the buyer with this phone, as it is stored in KeyCRM, e.g. +380501234567.').optional(),
      buyer_email: filterText('Only the buyer with this e-mail.').optional(),
      created_from: dateTime('Only buyers created from this moment (requires created_to).').optional(),
      created_to: dateTime('Only buyers created up to this moment (requires created_from).').optional(),
      updated_from: dateTime('Only buyers changed from this moment (requires updated_to).').optional(),
      updated_to: dateTime('Only buyers changed up to this moment (requires updated_from).').optional(),
      include: buyerInclude,
      limit,
      page,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.buyers, {
        query: { ...requested, include: joined(args.include) },
        filter: {
          buyer_id: joined(args.buyer_ids),
          buyer_phone: args.buyer_phone,
          buyer_email: args.buyer_email,
          created_between: between(args.created_from, args.created_to, 'created'),
          updated_between: between(args.updated_from, args.updated_to, 'updated'),
        },
      });
      return { data: paginated(response, requested, summarizeBuyer) };
    },
  }),

  defineTool({
    name: 'get_buyer',
    title: 'Get a buyer',
    description:
      'Returns one buyer in full: name, phones, e-mails, birthday, note and dates (UTC). With `include`: delivery addresses, the company, the manager, loyalty programmes and custom fields. The result is personal data of a customer.',
    access: 'read',
    inputSchema: z.strictObject({
      buyer_id: id('Buyer id in KeyCRM'),
      include: buyerInclude,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => ({
      data: await client.request(ENDPOINTS.buyer, {
        pathParams: { buyerId: args.buyer_id },
        query: { include: joined(args.include) },
      }),
    }),
  }),

  defineTool({
    name: 'list_pipelines',
    title: 'List pipelines',
    description:
      'Lists the pipelines (воронки) of the account: id, name and type. A pipeline is a board of lead cards moving through stages. Use the id with list_pipeline_statuses and list_pipeline_cards, and as pipeline_id of a new card. KeyCRM answers with an error when the pipelines section is switched off in the CRM settings.',
    access: 'read',
    inputSchema: z.strictObject({ limit, page }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.pipelines, { query: { ...requested } });
      return { data: paginated(response, requested, summarizePipeline) };
    },
  }),

  defineTool({
    name: 'list_pipeline_statuses',
    title: 'List the stages of a pipeline',
    description:
      'Lists the stages (statuses) of one pipeline: id, title, system name, whether the stage is final and how many leads are in it. Use the ids to filter list_pipeline_cards and to read status_id in its results.',
    access: 'read',
    inputSchema: z.strictObject({
      pipeline_id: id('Pipeline id from list_pipelines'),
      limit,
      page,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.pipelineStatuses, {
        pathParams: { pipelineId: args.pipeline_id },
        query: { ...requested },
      });
      return { data: paginated(response, requested, summarizePipelineStatus) };
    },
  }),

  defineTool({
    name: 'list_pipeline_cards',
    title: 'List pipeline cards (leads)',
    description:
      'Lists the cards of the pipelines, i.e. leads and deals: id, title, stage (status_id), source, responsible manager, comment, the planned next contact (communicate_at) and dates (UTC). Filters: pipeline, stage, source, and periods of creation and update. The contact person, the stage name and the manager are returned only when asked for with `include`. Use get_pipeline_card for the complete record.',
    access: 'read',
    inputSchema: z.strictObject({
      pipeline_id: id('Only cards of this pipeline (id from list_pipelines)').optional(),
      status_ids: idList('Only cards in these stages (ids from list_pipeline_statuses)'),
      source_ids: idList('Only cards from these sources (ids from list_order_sources)'),
      created_from: dateTime('Only cards created from this moment (requires created_to).').optional(),
      created_to: dateTime('Only cards created up to this moment (requires created_from).').optional(),
      updated_from: dateTime('Only cards changed from this moment (requires updated_to).').optional(),
      updated_to: dateTime('Only cards changed up to this moment (requires updated_from).').optional(),
      include: cardInclude,
      limit,
      page,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.pipelineCards, {
        query: { ...requested, include: joined(args.include) },
        filter: {
          pipeline_id: args.pipeline_id === undefined ? undefined : String(args.pipeline_id),
          status_id: joined(args.status_ids),
          source_id: joined(args.source_ids),
          created_between: between(args.created_from, args.created_to, 'created'),
          updated_between: between(args.updated_from, args.updated_to, 'updated'),
        },
      });
      return { data: paginated(response, requested, summarizeCard) };
    },
  }),

  defineTool({
    name: 'get_pipeline_card',
    title: 'Get a pipeline card (lead)',
    description:
      'Returns one pipeline card in full: title, stage, source, manager, comment, UTM marks, the planned next contact and dates (UTC). With `include`: the contact person with the linked buyer, products, payments, the stage, the manager and custom fields. The result can contain customer contact data.',
    access: 'read',
    inputSchema: z.strictObject({
      card_id: id('Pipeline card id'),
      include: cardInclude,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const response = await client.request(ENDPOINTS.pipelineCard, {
        pathParams: { cardId: args.card_id },
        query: { include: joined(args.include) },
      });
      return { data: singleRecord(response, 'pipeline card') };
    },
  }),

  defineTool({
    name: 'list_users',
    title: 'List users (managers)',
    description:
      'Lists the users of the KeyCRM account, i.e. managers: id, full name, login, e-mail, role id and status (active or blocked). Use the id as manager_id of a new pipeline card and to read manager_id in orders and cards.',
    access: 'read',
    inputSchema: z.strictObject({ limit, page }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const requested = resolvePage(args);
      const response = await client.request(ENDPOINTS.users, { query: { ...requested } });
      return { data: paginated(response, requested, summarizeUser) };
    },
  }),
];

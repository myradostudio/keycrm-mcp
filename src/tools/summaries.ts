/**
 * Compact projections for list tools.
 *
 * Full API objects carry a lot (an order with everything included has its buyer,
 * products with catalogue records, payments, shipping history). List tools
 * return these summaries to keep the model's context small; the matching
 * `get_*` tool returns the complete object.
 *
 * Field names come from the response schemas of the OpenAPI document. Every
 * function tolerates missing fields, so an API change degrades to a sparser
 * summary instead of an error.
 */

import { isObject, objects } from './schemas.js';

type Json = Record<string, unknown>;

/** Copies the listed keys that are present, not null and not an empty string. */
function pick(source: unknown, keys: readonly string[]): Json {
  const result: Json = {};
  if (!isObject(source)) return result;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function pickNested(source: Json, key: string, keys: readonly string[]): Json {
  const nested = pick(source[key], keys);
  return Object.keys(nested).length > 0 ? { [key]: nested } : {};
}

function pickList(source: Json, key: string, keys: readonly string[]): Json {
  const items = objects(source[key]).map((item) => pick(item, keys));
  return items.length > 0 ? { [key]: items } : {};
}

const PERSON = ['id', 'full_name', 'phone', 'email'] as const;

export function summarizeOrder(order: Json): Json {
  return {
    ...pick(order, [
      'id',
      'source_uuid',
      'source_id',
      'status_id',
      'status_group_id',
      'grand_total',
      'total_discount',
      'shipping_price',
      'payment_status',
      'buyer_comment',
      'manager_comment',
      'ordered_at',
      'created_at',
      'updated_at',
      'closed_at',
    ]),
    // The parts below are present only when the caller asked for them with `include`.
    ...pickNested(order, 'buyer', PERSON),
    ...pickNested(order, 'status', ['id', 'name']),
    ...pickNested(order, 'manager', ['id', 'full_name']),
    ...pickList(order, 'products', ['name', 'sku', 'price_sold', 'price', 'quantity', 'unit_type']),
    ...pickList(order, 'payments', ['id', 'amount', 'actual_currency', 'status', 'payment_method_id', 'payment_date']),
    ...pickNested(order, 'shipping', [
      'delivery_service_id',
      'tracking_code',
      'shipping_status',
      'shipping_address_city',
      'shipping_receive_point',
      'recipient_full_name',
      'recipient_phone',
    ]),
    ...pickList(order, 'tags', ['id', 'name']),
  };
}

export function summarizeBuyer(buyer: Json): Json {
  return {
    ...pick(buyer, ['id', 'full_name', 'phone', 'email', 'birthday', 'note', 'created_at', 'updated_at']),
    ...pickNested(buyer, 'company', ['id', 'name']),
    ...pickNested(buyer, 'manager', ['id', 'full_name']),
  };
}

export function summarizePipeline(pipeline: Json): Json {
  return pick(pipeline, ['id', 'name', 'lead_type', 'target_type', 'use_payments']);
}

export function summarizePipelineStatus(status: Json): Json {
  return pick(status, ['id', 'pipeline_id', 'title', 'alias', 'is_final', 'leads_count']);
}

export function summarizeCard(card: Json): Json {
  const contact = isObject(card['contact']) ? card['contact'] : undefined;
  return {
    ...pick(card, [
      'id',
      'title',
      'status_id',
      'source_id',
      'manager_id',
      'contact_id',
      'manager_comment',
      'is_finished',
      'target_type',
      'target_id',
      'communicate_at',
      'status_changed_at',
      'created_at',
      'updated_at',
    ]),
    // The parts below are present only when the caller asked for them with `include`.
    ...(contact === undefined ? {} : { contact: pick(contact, [...PERSON, 'client_id', 'social_name']) }),
    ...pickNested(card, 'status', ['id', 'name', 'pipeline_id']),
    ...pickNested(card, 'manager', ['id', 'full_name']),
  };
}

export function summarizeOrderStatus(status: Json): Json {
  return pick(status, ['id', 'name', 'alias', 'group_id', 'is_active', 'is_closing_order']);
}

export function summarizeSource(source: Json): Json {
  return pick(source, ['id', 'name', 'alias', 'driver', 'currency_code']);
}

export function summarizeUser(user: Json): Json {
  return pick(user, ['id', 'full_name', 'username', 'email', 'role_id', 'status']);
}

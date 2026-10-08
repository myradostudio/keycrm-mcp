/**
 * Catalogue of the KeyCRM API operations this server calls.
 *
 * Paths are taken from the official OpenAPI document
 * (https://docs.keycrm.app/api.yaml). tests/spec.test.ts compares every entry
 * with a snapshot of that document, so an endpoint cannot be added or changed
 * here without the spec agreeing.
 */

/** The document declares the server `https://openapi.keycrm.app/v1`; paths below are relative to it. */
export const API_BASE_PATH = '/v1';

export interface Endpoint {
  readonly method: 'GET' | 'POST';
  /** Path template; `{name}` segments are filled from path parameters. */
  readonly path: string;
}

function endpoint(method: Endpoint['method'], path: string): Endpoint {
  return { method, path };
}

export const ENDPOINTS = {
  // Orders
  orders: endpoint('GET', '/order'),
  order: endpoint('GET', '/order/{orderId}'),
  orderStatuses: endpoint('GET', '/order/status'),
  orderSources: endpoint('GET', '/order/source'),

  // Buyers
  buyers: endpoint('GET', '/buyer'),
  buyer: endpoint('GET', '/buyer/{buyerId}'),

  // Pipelines (leads)
  pipelines: endpoint('GET', '/pipelines'),
  pipelineStatuses: endpoint('GET', '/pipelines/{pipelineId}/statuses'),
  pipelineCards: endpoint('GET', '/pipelines/cards'),
  pipelineCard: endpoint('GET', '/pipelines/cards/{cardId}'),
  createPipelineCard: endpoint('POST', '/pipelines/cards'),

  // Users (managers)
  users: endpoint('GET', '/users'),
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof ENDPOINTS;

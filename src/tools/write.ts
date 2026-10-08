/**
 * Write tools. They are registered only when KEYCRM_ALLOW_WRITE=1.
 *
 * Input schemas are strict (unknown keys are rejected) on purpose: a misspelled
 * field must fail loudly instead of being dropped silently and leaving a lead
 * without its phone number.
 */

import { z } from 'zod';

import type { KeycrmClient, RequestOptions } from '../client.js';
import { ENDPOINTS, type Endpoint } from '../endpoints.js';
import { describeError, KeycrmApiError, RateLimitError, ToolError } from '../errors.js';
import { dateTime, id, isObject, toUtc } from './schemas.js';
import { summarizeCard } from './summaries.js';
import { ADDITIVE_WRITE, defineTool, type AnyTool } from './types.js';

/**
 * True when the failure proves that KeyCRM did not create anything: the request
 * was never sent, or the API refused it with a client error. 408 and 429 are
 * left out on purpose: they say nothing about what happened.
 */
function isDefiniteRefusal(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof ToolError) return true;
  return (
    error instanceof KeycrmApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * Sends a request that creates a record. Unless the failure is a definite
 * refusal, the outcome is unknown (no response, a gateway error, an unreadable
 * response): the error then tells the model how to find out instead of inviting
 * a blind retry that could create the same lead twice.
 */
async function submit(client: KeycrmClient, endpoint: Endpoint, options: RequestOptions, recovery: string): Promise<unknown> {
  try {
    return await client.request(endpoint, options);
  } catch (error) {
    if (isDefiniteRefusal(error)) throw error;
    throw new ToolError(
      `${describeError(error, { hints: false })}
It is unknown whether KeyCRM created the record. Do not simply repeat the call. ${recovery}`,
    );
  }
}

/** Drops keys whose value is undefined so they are not serialised at all. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const text = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what);

const utm = (what: string) => text(255, `UTM mark: ${what}.`).optional();

const contact = z
  .strictObject({
    full_name: text(255, 'Name of the person.').optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s()-]{7,25}$/, 'Must be a phone number: digits, spaces, brackets and dashes, optionally with a leading +.')
      // Counted without the separators: a row of dashes is not a phone.
      .refine((value) => value.replace(/\D/g, '').length >= 7, 'Must hold at least 7 digits.')
      .optional()
      .describe('Phone. KeyCRM recommends the international format with a plus, e.g. +380501234567.'),
    email: z.email().optional().describe('E-mail of the person.'),
    buyer_id: id('Id of an existing buyer (client_id in KeyCRM). The card is then created for that buyer and KeyCRM ignores the other contact fields')
      .optional(),
  })
  .refine((value) => value.phone !== undefined || value.email !== undefined || value.buyer_id !== undefined, {
    message: 'Give a phone, an e-mail or buyer_id: a lead nobody can reach is of no use. A name alone is not enough.',
  })
  .describe('Who the lead is: a phone or an e-mail, preferably with a name, or the id of an existing buyer.');

/** The arguments for list_pipeline_cards that show what was created around a moment; put into the advice as they are. */
export function recoveryArguments(at: Date): { created_from: string; created_to: string; include: string[]; limit: number } {
  const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
  return {
    // A few minutes each way: the clocks of this machine and of KeyCRM need not agree to the second.
    created_from: iso(at.getTime() - 5 * 60_000),
    created_to: iso(at.getTime() + 5 * 60_000),
    include: ['contact.client'],
    limit: 50,
  };
}

const customField = z.strictObject({
  uuid: text(100, 'External id of the custom field, as shown in the KeyCRM settings, e.g. LD_1021.'),
  value: text(2000, 'Value of the field.'),
});

export const writeTools: readonly AnyTool[] = [
  defineTool({
    name: 'create_pipeline_card',
    title: 'Create a pipeline card (lead)',
    description:
      'Creates a new card in a pipeline, i.e. registers a lead that managers will see and work on. Without pipeline_id KeyCRM uses the first pipeline of the list. Give the contact as a phone or an e-mail, preferably with a name, or as the id of an existing buyer (find one with list_buyers by phone or e-mail first, so that the lead is attached to the right person). The call is not idempotent: repeating it creates a second card. State who the lead is and what the card will say, and get explicit confirmation from the user before calling. Not covered by this tool: products and payments of a card.',
    access: 'write',
    inputSchema: z.strictObject({
      contact,
      title: text(255, 'Title of the card. Without it KeyCRM uses the id of the new card.').optional(),
      pipeline_id: id('Pipeline id from list_pipelines. Without it KeyCRM uses the first pipeline of the list').optional(),
      source_id: id('Source id from list_order_sources').optional(),
      manager_id: id('Id of the responsible manager from list_users').optional(),
      manager_comment: text(5000, 'Comment for the manager: what the person asked for, in plain words.').optional(),
      communicate_at: dateTime('When to contact the person next.').optional(),
      utm_source: utm('campaign source'),
      utm_medium: utm('traffic type'),
      utm_campaign: utm('campaign name'),
      utm_term: utm('keyword'),
      utm_content: utm('ad identifier'),
      custom_fields: z.array(customField).min(1).max(50).optional().describe('Values for custom fields of the card.'),
    }),
    annotations: ADDITIVE_WRITE,
    handler: async (args, { client }) => {
      const body = compact({
        title: args.title,
        source_id: args.source_id,
        manager_comment: args.manager_comment,
        manager_id: args.manager_id,
        pipeline_id: args.pipeline_id,
        communicate_at: args.communicate_at === undefined ? undefined : toUtc(args.communicate_at),
        contact: compact({
          full_name: args.contact.full_name,
          email: args.contact.email,
          phone: args.contact.phone,
          client_id: args.contact.buyer_id,
        }),
        utm_source: args.utm_source,
        utm_medium: args.utm_medium,
        utm_campaign: args.utm_campaign,
        utm_term: args.utm_term,
        utm_content: args.utm_content,
        custom_fields: args.custom_fields,
      });

      const check = `Call list_pipeline_cards with ${JSON.stringify(recoveryArguments(new Date()))} and follow next_page to the end: these are the cards created around this attempt.`;
      const response = await submit(
        client,
        ENDPOINTS.createPipelineCard,
        { body },
        `${check} Create the card again only if none of them has this contact.`,
      );

      if (!isObject(response) || typeof response['id'] !== 'number') {
        return {
          note: `KeyCRM answered with success but without a card id. The card was most likely created. ${check} Do not create it again unless none of them has this contact.`,
          data: response,
        };
      }
      return { note: `KeyCRM created pipeline card ${response['id']}.`, data: summarizeCard(response) };
    },
  }),
];

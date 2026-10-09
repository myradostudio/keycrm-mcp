// Runs the tools of the built server against the real KeyCRM API.
//
// The unit tests replace the API with a stand-in; this script is the other half:
// it starts dist/index.js the way an MCP host does and calls every read tool
// with every argument it has. The values for the filters (a status, a source, a
// phone, a period) it takes from the records the account already holds, so each
// filtered list has to bring back the record the values came from. It prints
// counts and field names, not what the records hold; the one exception is the
// list of pipelines with their ids and names, which the write check needs.
//
// Usage:
//   npm run live-check                                              the read tools; nothing is created
//   node scripts/live-check.mjs --create-card --pipeline-id 3      the write tool: creates one card
//
// The key is taken from KEYCRM_API_KEY, or asked for when that is not set; the
// input is hidden. It goes to the server through its environment, not through a
// command line, and nothing that is typed is echoed or printed.
//
// A run without arguments sends 19 requests at most, one less than KeyCRM allows
// per minute for one key. Wait a minute before running it again. For the same
// reason `page` is sent as 1 everywhere: a second page would be a request too many.
//
// --create-card is never the default and needs --pipeline-id. KeyCRM documents no
// API operation that deletes a pipeline card, so the card this creates stays in
// that pipeline until somebody deletes it by hand. The script says so and waits
// for "yes" before it creates anything. With these two arguments the read checks
// are not run: only the card is created, read back and looked up.
//
// It needs the network and a real account, so it is not part of `npm test` or of
// CI; the tests run this script against a local stand-in (tests/live-check.test.ts).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { createPrompter, createReporter, exitAfterOutput, expect, Interrupted, need, Skip, Stop } from './live-check-io.mjs';

const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const READ_TOOLS = [
  'list_orders',
  'get_order',
  'list_order_statuses',
  'list_order_sources',
  'list_buyers',
  'get_buyer',
  'list_pipelines',
  'list_pipeline_statuses',
  'list_pipeline_cards',
  'get_pipeline_card',
  'list_users',
];
const WRITE_TOOLS = ['create_pipeline_card'];

// The values each tool offers for `include`, written out: the check is to send every one of them.
const ORDER_LIST_INCLUDES = ['buyer', 'status', 'manager', 'products.offer', 'payments', 'shipping.deliveryService', 'tags'];
const ORDER_INCLUDES = [...ORDER_LIST_INCLUDES, 'marketing', 'shipping.lastHistory', 'expenses', 'custom_fields', 'assigned'];
const BUYER_LIST_INCLUDES = ['company', 'manager'];
const BUYER_INCLUDES = [...BUYER_LIST_INCLUDES, 'shipping', 'loyalty', 'custom_fields'];
const CARD_LIST_INCLUDES = ['contact.client', 'status', 'manager'];
const CARD_INCLUDES = [...CARD_LIST_INCLUDES, 'products', 'payments', 'custom_fields'];
const PAYMENT_STATUSES = ['not_paid', 'part_paid', 'paid', 'overpaid'];

const CONTACT = { full_name: 'MCP live check', email: 'live-check@example.com' };
const CARD_COMMENT = 'Created by the live check of keycrm-mcp. Nobody is waiting for an answer: delete this card.';
const UTM = { utm_source: 'keycrm-mcp', utm_medium: 'live-check', utm_campaign: 'live-check', utm_term: 'live-check', utm_content: 'live-check' };

/** How the write tool of the server begins the sentence about a request that got no definite answer. */
const UNKNOWN_OUTCOME = 'It is unknown whether';

const ID = /^[1-9]\d{0,14}$/;
const USAGE =
  'The script takes --create-card together with --pipeline-id and a number, and nothing else. The key is never passed on the command line: the script asks for it.';

const report = createReporter();
const prompt = createPrompter();

/** Ends the run before anything is sent: a mistake in how the script was started. */
async function refuse(message) {
  report.say(message);
  await exitAfterOutput(2);
}

const args = process.argv.slice(2);
let createCard = false;
let pipelineText;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--create-card') createCard = true;
  else if (args[index] === '--pipeline-id' && ID.test(args[index + 1] ?? '')) pipelineText = args[(index += 1)];
  // What was passed is not repeated: it may be a key put on the command line by mistake.
  else await refuse(USAGE);
}
if (createCard && pipelineText === undefined) {
  await refuse('--create-card needs --pipeline-id and a number: the card must go to a pipeline you chose. `npm run live-check` lists the pipelines.');
}
if (!createCard && pipelineText !== undefined) await refuse('--pipeline-id is used with --create-card only. Without --create-card nothing is created.');
if (!existsSync(SERVER_ENTRY)) await refuse('dist/index.js is missing. Run `npm run build` first, or start the check with `npm run live-check`.');
const pipelineId = pipelineText === undefined ? undefined : Number(pipelineText);

let apiKey = (process.env.KEYCRM_API_KEY ?? '').trim();
try {
  if (apiKey === '') apiKey = await prompt.secret('KeyCRM API key (input is hidden): ');
} catch (error) {
  if (error instanceof Interrupted) process.exit(130);
  throw error;
}
if (apiKey === '') await refuse('No API key was given, so there is nothing to check with.');
report.hide(apiKey, apiKey.replace(/^bearer\s+/i, ''));

const env = { ...getDefaultEnvironment(), KEYCRM_API_KEY: apiKey };
if (process.env.KEYCRM_API_URL) env.KEYCRM_API_URL = process.env.KEYCRM_API_URL;
if (createCard) env.KEYCRM_ALLOW_WRITE = '1';

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: 'pipe' });
let serverLog = '';
transport.stderr?.on('data', (chunk) => (serverLog += chunk));
const client = new Client({ name: 'live-check', version: '1.0.0' });
try {
  await client.connect(transport);
} catch (error) {
  // A key with a space in it, for example: the server explains on stderr why it refused to start.
  report.say('The server did not start.');
  report.say(serverLog.trim() || (error instanceof Error ? error.message : String(error)));
  await exitAfterOutput(1);
}

const firstLine = (text) => text.split('\n')[0];

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const isError = result.isError === true;
  // With a rejected key or a used-up rate every further line would be the same failure. A write that got no
  // definite answer is left to its check: that one has to say that a card may exist.
  if (isError && /^KeyCRM API error \(HTTP 401\)/.test(text)) throw new Stop(text);
  if (isError && !text.includes(UNKNOWN_OUTCOME) && (/^KeyCRM API error \(HTTP 429\)/.test(text) || text.startsWith('Not sent: '))) {
    throw new Stop(`${text}\nKeyCRM counts 20 requests per minute for one key. Wait a minute and run the check again.`);
  }
  return {
    isError,
    text,
    /** The data of the answer. A refused call throws its refusal. */
    get json() {
      if (isError) throw new Error(text);
      const start = text.search(/^[{[]/m);
      return start === -1 ? undefined : JSON.parse(text.slice(start));
    },
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const fieldsOf = (object) => Object.keys(object).join(', ');
const second = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** KeyCRM writes a moment as "2026-10-07 08:15:00", in UTC. Returns it in milliseconds. */
function moment(text, field) {
  const ms = typeof text === 'string' ? Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`) : Number.NaN;
  // The shape and not the value: digits become 9.
  expect(!Number.isNaN(ms), `${field} is not a moment the check can read: it looks like ${String(text).replace(/\d/g, '9')}`);
  return ms;
}

/** The two ends of a period that holds the moment, as the tools take them. */
function around(text, field, name) {
  const ms = moment(text, field);
  return { [`${name}_from`]: second(ms - 60_000), [`${name}_to`]: second(ms + 60_000) };
}

/** Every record of a filtered list lies inside the period that was asked for; otherwise the filter was ignored. */
function expectWithin(results, filters, field, name) {
  const from = Date.parse(filters[`${name}_from`]);
  const to = Date.parse(filters[`${name}_to`]);
  const inside = (item) => {
    const ms = moment(item[field], field);
    return ms >= from && ms <= to;
  };
  expect(results.every(inside), `${name}_from and ${name}_to were not applied: records of another time came back`);
}

const digits = (value) => String(value ?? '').replace(/\D/g, '');
const samePhone = (asked) => (value) => digits(value) !== '' && digits(value) === digits(asked);
const sameEmail = (asked) => (value) => String(value ?? '').toLowerCase() === asked.toLowerCase();
/** A buyer has lists of phones and e-mails; the buyer inside an order has one of each. */
const allOf = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/** What every list tool promises about its pagination block. */
function expectPage(json, limit, page) {
  expect(Array.isArray(json?.results), 'no results in the answer');
  const { pagination } = json;
  expect(pagination?.page === page && pagination.limit === limit, `pagination says page ${pagination?.page}, limit ${pagination?.limit}`);
  expect(pagination.returned === json.results.length && json.results.length <= limit, 'returned does not match the list, or the list is longer than the limit');
  expect(json.results.every((item) => Number.isInteger(item.id)), 'a record lacks its id');
}

/** A plain directory: one call with the largest page, as every argument the tool has. */
async function directory(tool, extra = {}) {
  const { json } = await call(tool, { ...extra, limit: 50, page: 1 });
  expectPage(json, 50, 1);
  return json.results;
}

const firstOf = (value) => allOf(value)[0];

const counted = (results, what) => (results.length === 0 ? `no ${what}` : `${what}: ${results.length}; fields: ${fieldsOf(results[0])}`);

/** The card this run created. KeyCRM cannot delete it through the API, so the last lines always name it. */
let createdCard;
const cardTitle = `MCP live check ${today()}: delete this card`;

report.say(
  `KeyCRM live check, ${today()}, ${createCard ? `the write tool only: one card is created in pipeline ${pipelineId} and stays there` : 'read tools only, nothing is created'}`,
);

try {
  await report.check(createCard ? 'the server offers the 11 read tools and the write tool' : 'the server offers the 11 read tools and no write tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const expected = createCard ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
    expect(JSON.stringify(names) === JSON.stringify(expected), `the server offers ${names.join(', ')}`);
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
    expect(JSON.stringify(readOnly) === JSON.stringify(READ_TOOLS), `marked as read-only: ${readOnly.join(', ')}`);
    return createCard ? `write tool: ${WRITE_TOOLS.join(', ')}` : 'read-only';
  });

  if (createCard) {
    report.say('');
    report.say(`Write check: one card is created in pipeline ${pipelineId}, and it stays there.`);
    report.say('KeyCRM has no API operation that deletes a pipeline card: its OpenAPI document (version 1.2.0) deletes only a tag or an attachment.');
    report.say(`The card "${cardTitle}" will be in the pipeline until somebody deletes it by hand in KeyCRM.`);
    report.say(`Its contact is "${CONTACT.full_name}", ${CONTACT.email}. No manager and no source are set.`);
    const answer = await prompt.line(`Type yes to create the card in pipeline ${pipelineId}: `);
    if (answer.toLowerCase() !== 'yes') {
      report.skip('create_pipeline_card, get_pipeline_card, list_pipeline_cards', 'not confirmed, nothing was created');
    } else {
      // The same hour tomorrow, with the offset of Kyiv in winter, so that the conversion to UTC is really made.
      const tomorrow = Date.now() + 86_400_000;
      const communicateAt = `${new Date(tomorrow + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;
      const startedAt = Date.now();

      await report.check('create_pipeline_card: contact, title, pipeline_id, manager_comment, communicate_at, utm marks', async () => {
        const result = await call('create_pipeline_card', {
          contact: CONTACT,
          title: cardTitle,
          pipeline_id: pipelineId,
          manager_comment: CARD_COMMENT,
          communicate_at: communicateAt,
          ...UTM,
        });
        if (result.isError && result.text.includes(UNKNOWN_OUTCOME)) createdCard = { id: 'with an unknown id', doubt: true };
        // A refusal ends the check here. Past this line KeyCRM said yes: a card exists, with or without an id in the answer.
        const { json } = result;
        createdCard = Number.isInteger(json?.id) ? { id: String(json.id) } : { id: 'with an unknown id', doubt: true };
        expect(Number.isInteger(json?.id), `no card id came back: ${firstLine(result.text)}`);
        return `card ${json.id} created; fields: ${fieldsOf(json)}`;
      });

      if (createdCard !== undefined && createdCard.doubt !== true) {
        const cardId = Number(createdCard.id);
        await report.check('get_pipeline_card: the new card holds what was sent, in the pipeline that was asked for', async () => {
          const { json } = await call('get_pipeline_card', { card_id: cardId, include: CARD_INCLUDES });
          expect(json.id === cardId, 'another card came back');
          expect(json.title === cardTitle, 'the title is not the one that was sent');
          expect(json.manager_comment === CARD_COMMENT, 'manager_comment is not the one that was sent');
          expect(json.contact?.full_name === CONTACT.full_name && json.contact.email === CONTACT.email, 'the contact is not the one that was sent');
          expect(json.status?.pipeline_id === pipelineId, `the card is in pipeline ${json.status?.pipeline_id}, not in ${pipelineId}`);
          for (const [name, value] of Object.entries(UTM)) expect(json[name] === value, `${name} is not the one that was sent`);
          expect(moment(json.communicate_at, 'communicate_at') === tomorrow - (tomorrow % 1000), 'communicate_at is not the moment that was sent, converted to UTC');
          return `fields: ${fieldsOf(json)}`;
        });

        await report.check('list_pipeline_cards: the new card is found by its pipeline and the time of its creation', async () => {
          // What the tool advises when the answer to a creation got lost: a few minutes each way.
          const period = { created_from: second(startedAt - 5 * 60_000), created_to: second(Date.now() + 5 * 60_000) };
          const { json } = await call('list_pipeline_cards', { pipeline_id: pipelineId, ...period, include: ['contact.client'], limit: 50 });
          expectPage(json, 50, 1);
          expect(json.results.some((item) => item.id === cardId), 'the new card is not among the cards created in these minutes');
          return `cards created in these minutes: ${json.results.length}`;
        });
      }
    }
  } else {
    await report.check('list_order_statuses: limit, page', async () => counted(await directory('list_order_statuses'), 'statuses'));
    await report.check('list_order_sources: limit, page', async () => counted(await directory('list_order_sources'), 'sources'));
    await report.check('list_users: limit, page', async () => counted(await directory('list_users'), 'users'));

    let pipeline;
    await report.check('list_pipelines: limit, page', async () => {
      const result = await call('list_pipelines', { limit: 50, page: 1 });
      // Documented by KeyCRM for an account where the pipelines section is switched off.
      if (result.isError && /^KeyCRM API error \(HTTP 400\)/.test(result.text)) throw new Skip(`pipelines are switched off in this account: ${firstLine(result.text)}`);
      const { json } = result;
      expectPage(json, 50, 1);
      [pipeline] = json.results;
      // Ids and names, the one place where names are printed: --create-card needs a pipeline to be chosen.
      return json.results.length === 0 ? 'no pipelines' : `pipelines: ${json.results.map((item) => `${item.id} "${item.name}"`).join(', ')}`;
    });

    await report.check('list_pipeline_statuses: pipeline_id, limit, page', async () => {
      need(pipeline, 'a pipeline');
      const stages = await directory('list_pipeline_statuses', { pipeline_id: pipeline.id });
      expect(stages.every((stage) => stage.pipeline_id === undefined || stage.pipeline_id === pipeline.id), 'a stage of another pipeline came back');
      return counted(stages, 'stages');
    });

    // A filter is checked for real only where nothing narrower stands beside it: a period of two minutes
    // would hide a status that the API ignores. So the lists below are few and each has one job.

    let order;
    await report.check('list_orders: include, sort, limit, page', async () => {
      const { json } = await call('list_orders', { include: ORDER_LIST_INCLUDES, sort: 'newest', limit: 2, page: 1 });
      expectPage(json, 2, 1);
      [order] = json.results;
      if (order === undefined) return 'the account has no orders';
      expect(json.results.length < 2 || order.id > json.results[1].id, 'sort "newest" did not put the larger id first');
      const parts = ['buyer', 'status', 'manager', 'products', 'payments', 'shipping', 'tags'].filter((part) => part in order);
      return `orders in the account: ${json.pagination.total ?? 'not reported'}; fields: ${fieldsOf(order)}; came with include: ${parts.join(', ') || 'nothing'}`;
    });

    let shipped = false;
    await report.check('get_order: order_id, include', async () => {
      need(order, 'an order');
      const { json } = await call('get_order', { order_id: order.id, include: ORDER_INCLUDES });
      expect(json.id === order.id, 'another order came back');
      shipped = typeof json.shipping?.shipping_date_actual === 'string';
      return `fields: ${fieldsOf(json)}`;
    });

    await report.check('list_orders: status_ids, source_ids, payment_statuses, has_tracking_code, shipping_*', async () => {
      need(order, 'an order');
      const hasCode = typeof order.shipping?.tracking_code === 'string';
      const filters = {
        status_ids: [order.status_id],
        source_ids: [order.source_id],
        ...(PAYMENT_STATUSES.includes(order.payment_status) ? { payment_statuses: [order.payment_status] } : {}),
        has_tracking_code: hasCode,
        // Every date an order could have been shipped on; it leaves out only the orders without a shipping date.
        ...(shipped ? { shipping_from: '2000-01-01T00:00:00Z', shipping_to: second(Date.now() + 366 * 86_400_000) } : {}),
      };
      const { json } = await call('list_orders', { ...filters, include: ['shipping.deliveryService'], sort: 'newest', limit: 50 });
      expectPage(json, 50, 1);
      expect(json.results.every((item) => item.status_id === order.status_id), 'status_ids was not applied');
      expect(json.results.every((item) => item.source_id === order.source_id), 'source_ids was not applied');
      expect(!('payment_statuses' in filters) || json.results.every((item) => item.payment_status === order.payment_status), 'payment_statuses was not applied');
      expect(json.results.every((item) => (typeof item.shipping?.tracking_code === 'string') === hasCode), 'has_tracking_code was not applied');
      expect(
        json.results.some((item) => item.id === order.id),
        `the order the values were taken from did not come back: one of ${Object.keys(filters).join(', ')} is not matched the way the server sends it`,
      );
      return `orders that match: ${json.results.length}; sent: ${Object.keys(filters).join(', ')}${shipped ? '' : '; shipping_from and shipping_to were not sent, the order has no shipping date'}`;
    });

    await report.check('list_orders: created_from, created_to, sort', async () => {
      need(order, 'an order');
      const filters = around(order.created_at, 'created_at', 'created');
      const { json } = await call('list_orders', { ...filters, sort: 'oldest', limit: 50 });
      expectPage(json, 50, 1);
      expect(json.results.some((item) => item.id === order.id), 'the order did not come back for the two minutes around its created_at: the period is not read as UTC, or not the way the server sends it');
      expectWithin(json.results, filters, 'created_at', 'created');
      expect(json.results.every((item, index) => index === 0 || item.id > json.results[index - 1].id), 'sort "oldest" did not put the smaller id first');
      return `orders created within two minutes of that one: ${json.results.length}`;
    });

    await report.check('list_orders: source_order_id, buyer_email, updated_from, updated_to', async () => {
      need(order, 'an order');
      const email = firstOf(order.buyer?.email);
      report.hide(email);
      const filters = {
        ...(typeof order.source_uuid === 'string' ? { source_order_id: order.source_uuid } : {}),
        ...(typeof email === 'string' ? { buyer_email: email } : {}),
        ...around(order.updated_at, 'updated_at', 'updated'),
      };
      const { json } = await call('list_orders', { ...filters, include: ['buyer'], sort: 'newest', limit: 50 });
      expectPage(json, 50, 1);
      expect(
        json.results.some((item) => item.id === order.id),
        `the order the values were taken from did not come back: one of ${Object.keys(filters).join(', ')} is not matched the way the server sends it`,
      );
      expect(!('source_order_id' in filters) || json.results.every((item) => item.source_uuid === order.source_uuid), 'source_order_id was not applied');
      expect(!('buyer_email' in filters) || json.results.every((item) => allOf(item.buyer?.email).some(sameEmail(email))), 'buyer_email was not applied: orders of other buyers came back');
      expectWithin(json.results, filters, 'updated_at', 'updated');
      return `orders that match: ${json.results.length}; sent: ${Object.keys(filters).join(', ')}`;
    });

    await report.check('list_orders: buyer_phone', async () => {
      need(order, 'an order');
      const phone = firstOf(order.buyer?.phone);
      if (typeof phone !== 'string') throw new Skip('the newest order has no buyer with a phone');
      report.hide(phone);
      const { json } = await call('list_orders', { buyer_phone: phone, include: ['buyer'], sort: 'newest', limit: 50 });
      expectPage(json, 50, 1);
      expect(json.results.some((item) => item.id === order.id), 'the order of that buyer did not come back: buyer_phone is not matched the way KeyCRM stores it');
      expect(json.results.every((item) => allOf(item.buyer?.phone).some(samePhone(phone))), 'buyer_phone was not applied: orders of other buyers came back');
      return `orders of that buyer: ${json.results.length}`;
    });

    let buyer;
    await report.check('list_buyers: buyer_ids, include, limit, page', async () => {
      const known = order?.buyer?.id;
      // The buyer of the newest order, or, when there is none, whoever is on top of the list.
      const { json } = await call('list_buyers', { ...(Number.isInteger(known) ? { buyer_ids: [known] } : {}), include: BUYER_LIST_INCLUDES, limit: 50, page: 1 });
      expectPage(json, 50, 1);
      expect(!Number.isInteger(known) || (json.results.length === 1 && json.results[0].id === known), 'buyer_ids did not bring back that buyer alone');
      [buyer] = json.results;
      return buyer === undefined ? 'the account has no buyers' : `fields: ${fieldsOf(buyer)}`;
    });

    await report.check('list_buyers: buyer_phone, created_*, updated_*', async () => {
      need(buyer, 'a buyer');
      const phone = firstOf(buyer.phone);
      if (typeof phone !== 'string') throw new Skip('the buyer has no phone');
      report.hide(phone);
      const filters = { buyer_phone: phone, ...around(buyer.created_at, 'created_at', 'created'), ...around(buyer.updated_at, 'updated_at', 'updated') };
      const { json } = await call('list_buyers', { ...filters, limit: 50 });
      expectPage(json, 50, 1);
      expect(
        json.results.some((item) => item.id === buyer.id),
        `the buyer the values were taken from did not come back: one of ${Object.keys(filters).join(', ')} is not matched the way the server sends it`,
      );
      expect(json.results.every((item) => allOf(item.phone).some(samePhone(phone))), 'buyer_phone was not applied: other buyers came back');
      expectWithin(json.results, filters, 'created_at', 'created');
      expectWithin(json.results, filters, 'updated_at', 'updated');
      return `buyers that match: ${json.results.length}`;
    });

    await report.check('list_buyers: buyer_email', async () => {
      need(buyer, 'a buyer');
      const email = firstOf(buyer.email);
      if (typeof email !== 'string') throw new Skip('the buyer has no e-mail');
      report.hide(email);
      const { json } = await call('list_buyers', { buyer_email: email, limit: 50 });
      expectPage(json, 50, 1);
      expect(json.results.some((item) => item.id === buyer.id), 'the buyer did not come back: buyer_email is not matched the way KeyCRM stores it');
      expect(json.results.every((item) => allOf(item.email).some(sameEmail(email))), 'buyer_email was not applied: other buyers came back');
      return `buyers that match: ${json.results.length}`;
    });

    await report.check('get_buyer: buyer_id, include', async () => {
      need(buyer, 'a buyer');
      const { json } = await call('get_buyer', { buyer_id: buyer.id, include: BUYER_INCLUDES });
      expect(json.id === buyer.id, 'another buyer came back');
      return `fields: ${fieldsOf(json)}`;
    });

    let card;
    await report.check('list_pipeline_cards: include, limit, page', async () => {
      need(pipeline, 'a pipeline');
      const { json } = await call('list_pipeline_cards', { include: CARD_LIST_INCLUDES, limit: 2, page: 1 });
      expectPage(json, 2, 1);
      [card] = json.results;
      if (card === undefined) return 'the account has no pipeline cards';
      const parts = ['contact', 'status', 'manager'].filter((part) => part in card);
      return `cards in the account: ${json.pagination.total ?? 'not reported'}; fields: ${fieldsOf(card)}; came with include: ${parts.join(', ') || 'nothing'}`;
    });

    await report.check('list_pipeline_cards: pipeline_id, status_ids, source_ids', async () => {
      need(card, 'a pipeline card');
      const filters = {
        ...(Number.isInteger(card.status?.pipeline_id) ? { pipeline_id: card.status.pipeline_id } : {}),
        status_ids: [card.status_id],
        ...(Number.isInteger(card.source_id) ? { source_ids: [card.source_id] } : {}),
      };
      const { json } = await call('list_pipeline_cards', { ...filters, include: ['status'], limit: 50 });
      expectPage(json, 50, 1);
      expect(json.results.every((item) => item.status_id === card.status_id), 'status_ids was not applied');
      expect(!('source_ids' in filters) || json.results.every((item) => item.source_id === card.source_id), 'source_ids was not applied');
      expect(!('pipeline_id' in filters) || json.results.every((item) => item.status?.pipeline_id === filters.pipeline_id), 'pipeline_id was not applied');
      expect(
        json.results.some((item) => item.id === card.id),
        `the card the values were taken from did not come back: one of ${Object.keys(filters).join(', ')} is not matched the way the server sends it`,
      );
      return `cards that match: ${json.results.length}; sent: ${Object.keys(filters).join(', ')}`;
    });

    await report.check('list_pipeline_cards: created_*, updated_*', async () => {
      need(card, 'a pipeline card');
      const filters = { ...around(card.created_at, 'created_at', 'created'), ...around(card.updated_at, 'updated_at', 'updated') };
      const { json } = await call('list_pipeline_cards', { ...filters, limit: 50 });
      expectPage(json, 50, 1);
      expect(json.results.some((item) => item.id === card.id), 'the card did not come back for the two minutes around its created_at and updated_at');
      expectWithin(json.results, filters, 'created_at', 'created');
      expectWithin(json.results, filters, 'updated_at', 'updated');
      return `cards that match: ${json.results.length}`;
    });

    await report.check('get_pipeline_card: card_id, include', async () => {
      need(card, 'a pipeline card');
      const { json } = await call('get_pipeline_card', { card_id: card.id, include: CARD_INCLUDES });
      expect(json.id === card.id, 'another card came back');
      return `fields: ${fieldsOf(json)}`;
    });
  }
} catch (error) {
  if (error instanceof Interrupted) {
    report.say('Interrupted.');
    report.counts.failed += 1;
  } else if (error instanceof Stop) {
    report.say('Stopped: the remaining checks were not run.');
  } else {
    throw error;
  }
} finally {
  if (createdCard !== undefined) {
    report.say('');
    report.say(
      createdCard.doubt === true
        ? `A card MAY EXIST in pipeline ${pipelineId}: KeyCRM gave no definite answer when it was created.`
        : `Card ${createdCard.id} is now in pipeline ${pipelineId} and the API cannot delete it.`,
    );
    report.say(`Look for "${cardTitle}" in KeyCRM and delete it by hand.`);
  }
}

await client.close();
await exitAfterOutput(report.finish());

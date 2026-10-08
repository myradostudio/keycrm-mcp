/**
 * The write tool, called through a real MCP client with KEYCRM_ALLOW_WRITE on.
 * Every request the server sends is checked against the OpenAPI snapshot.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { KeycrmClient } from '../src/client.js';
import { runTool } from '../src/server.js';
import { readTools } from '../src/tools/read.js';
import { recoveryArguments, writeTools } from '../src/tools/write.js';
import { hang, json } from './support/fake-api.js';
import * as fixtures from './support/fixtures.js';
import { IDS } from './support/fixtures.js';
import { createHarness, testConfig, type Harness } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const CARDS = '/v1/pipelines/cards';
const LEAD = { contact: { full_name: 'Ірина Тестова', phone: '+380501234567' } };

describe('opt-in', () => {
  it('registers no write tool unless the operator allowed it', async () => {
    harness = await createHarness();

    const { tools } = await harness.mcp.listTools();

    assert.ok(!tools.some((tool) => tool.name === 'create_pipeline_card'));
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    await assert.rejects(harness.call('create_pipeline_card', LEAD), /Tool create_pipeline_card not found/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('adds exactly one write tool after the read tools', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    assert.equal(tools.length, 12);
    assert.equal(tools.at(-1)?.name, 'create_pipeline_card');
    assert.deepEqual(writeTools.map((tool) => tool.name), ['create_pipeline_card']);
  });
});

describe('create_pipeline_card', () => {
  it('sends the smallest documented body and returns the new card', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json(fixtures.card, 201));

    const result = await harness.call('create_pipeline_card', LEAD);

    const request = harness.api.single;
    assert.equal(assertMatchesSpec(request), 'POST /pipelines/cards');
    assert.deepEqual(request.body, { contact: { full_name: 'Ірина Тестова', phone: '+380501234567' } });
    assert.equal(result.isError, false);
    assert.match(result.text, /^KeyCRM created pipeline card 880\.\n\n\{/);
    const data = JSON.parse(result.text.slice(result.text.indexOf('{')));
    assert.equal(data.id, IDS.card);
    assert.equal(data.status_id, IDS.pipelineStatus);
    assert.equal(data.contact_id, IDS.contact);
  });

  it('maps every argument onto the field KeyCRM documents', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json(fixtures.card, 201));

    await harness.callJson('create_pipeline_card', {
      contact: { full_name: '  Ірина Тестова ', phone: '+380 (50) 123-45-67', email: 'iryna@example.com' },
      title: 'Заявка: консультація',
      pipeline_id: IDS.pipeline,
      source_id: IDS.source,
      manager_id: IDS.manager,
      manager_comment: 'Просить передзвонити зранку',
      communicate_at: '2026-10-09T10:00:00+03:00',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'autumn',
      utm_term: 'crm',
      utm_content: 'ad-1',
      custom_fields: [{ uuid: 'LD_1021', value: 'Сайт' }],
    });

    const request = harness.api.single;
    assertMatchesSpec(request);
    assert.deepEqual(request.body, {
      title: 'Заявка: консультація',
      source_id: IDS.source,
      manager_comment: 'Просить передзвонити зранку',
      manager_id: IDS.manager,
      pipeline_id: IDS.pipeline,
      // KeyCRM works in UTC: 10:00 Kyiv summer time is 07:00 UTC.
      communicate_at: '2026-10-09 07:00:00',
      contact: { full_name: 'Ірина Тестова', email: 'iryna@example.com', phone: '+380 (50) 123-45-67' },
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'autumn',
      utm_term: 'crm',
      utm_content: 'ad-1',
      custom_fields: [{ uuid: 'LD_1021', value: 'Сайт' }],
    });
  });

  it('attaches the card to an existing buyer by id', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json(fixtures.card, 201));

    await harness.callJson('create_pipeline_card', { contact: { buyer_id: IDS.buyer }, title: 'Повторне звернення' });

    const request = harness.api.single;
    assertMatchesSpec(request);
    assert.deepEqual(request.body, { title: 'Повторне звернення', contact: { client_id: IDS.buyer } });
  });

  it('passes a refusal on and does not call the outcome unknown', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json({ message: 'Leads are not enabled' }, 400));

    const result = await harness.call('create_pipeline_card', LEAD);

    assert.equal(result.isError, true);
    assert.match(result.text, /^KeyCRM API error \(HTTP 400\): Leads are not enabled/);
    assert.doesNotMatch(result.text, /It is unknown whether/);
    assert.equal(harness.api.requests.length, 1, 'a refused card is not retried');
  });

  it('explains the documented HTTP 403', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json({ message: 'Forbidden' }, 403));

    const result = await harness.call('create_pipeline_card', LEAD);

    assert.match(result.text, /wrong arguments, or pipelines are not activated/);
  });

  for (const [name, response] of [
    ['a gateway error', json({ message: 'Bad gateway' }, 502)],
    ['HTTP 429', json({ message: 'Too Many Attempts.' }, 429)],
    ['a success status with an unreadable body', new Response('<html>', { status: 201 })],
  ] as const) {
    it(`says the outcome is unknown after ${name} and how to find out`, async () => {
      harness = await createHarness({ allowWrite: true });
      harness.api.on('POST', CARDS, response);

      const result = await harness.call('create_pipeline_card', LEAD);

      assert.equal(result.isError, true);
      assert.match(result.text, /It is unknown whether KeyCRM created the record\. Do not simply repeat the call\./);
      assert.match(result.text, /Call list_pipeline_cards with \{"created_from":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/);
      assert.match(result.text, /Create the card again only if none of them has this contact\./);
      assert.doesNotMatch(result.text, /Wait before retrying/, 'no advice to retry next to "do not repeat the call"');
      assert.equal(harness.api.requests.length, 1, 'the server never retries a card');
    });
  }

  it('gives advice the model can follow: the arguments it names are accepted by list_pipeline_cards', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json({ message: 'Bad gateway' }, 502));
    const listCards = readTools.find((tool) => tool.name === 'list_pipeline_cards');
    assert.ok(listCards);

    const result = await harness.call('create_pipeline_card', LEAD);

    // The advice quotes the arguments as JSON; take them out of the text and give them to the tool it names.
    const quoted = /Call list_pipeline_cards with (\{.*?\}) and follow next_page/.exec(result.text)?.[1];
    assert.ok(quoted, result.text);
    const advised = JSON.parse(quoted) as Record<string, unknown>;
    assert.equal(listCards.inputSchema.safeParse(advised).success, true, quoted);

    harness.api.on('GET', CARDS, json({ total: 0, data: [], next_page_url: null }));
    const followed = await harness.call('list_pipeline_cards', advised);
    assert.equal(followed.isError, false, followed.text);
    const sent = harness.api.requests.at(-1);
    assert.match(sent?.url.searchParams.get('filter[created_between]') ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(sent?.url.searchParams.get('include'), 'contact.client');
    assert.equal(sent?.url.searchParams.get('limit'), '50');
  });

  it('builds the check for a window of five minutes each way around the attempt', () => {
    assert.deepEqual(recoveryArguments(new Date('2026-10-08T07:00:30.500Z')), {
      created_from: '2026-10-08T06:55:30Z',
      created_to: '2026-10-08T07:05:30Z',
      include: ['contact.client'],
      limit: 50,
    });
  });

  it('says the outcome is unknown after a timeout', async () => {
    const config = testConfig({ allowWrite: true, timeoutMs: 30 });
    const client = new KeycrmClient({ config, fetch: (_url, init) => hang(init) });
    const [tool] = writeTools;
    assert.ok(tool);

    const result = await runTool(tool, LEAD, { config, client });

    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /^POST \/pipelines\/cards timed out after 0\.03 s\.\nIt is unknown whether/);
  });

  it('does not report a card it has no id for', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CARDS, json({ status: true }, 201));

    const result = await harness.call('create_pipeline_card', LEAD);

    assert.equal(result.isError, false);
    assert.match(result.text, /answered with success but without a card id/);
    assert.match(result.text, /Call list_pipeline_cards with \{"created_from"/);
    assert.match(result.text, /Do not create it again unless none of them has this contact\./);
  });

  it('validates the arguments before anything is sent', async () => {
    harness = await createHarness({ allowWrite: true });
    const invalid: Record<string, unknown>[] = [
      {},
      { contact: {} },
      { contact: { full_name: '   ' } },
      // A name alone: nobody could reach this lead.
      { contact: { full_name: 'Ірина Тестова' } },
      { contact: { phone: 'call me' } },
      { contact: { phone: '---------' } },
      { contact: { phone: '(((  )))' } },
      { contact: { phone: '12-34' } },
      { contact: { email: 'not-an-email' } },
      { contact: { buyer_id: 0 } },
      { contact: { phone: '+380501234567', telegram: '@iryna' } },
      { ...LEAD, pipeline_id: 'main' },
      { ...LEAD, communicate_at: '2026-10-09 10:00' },
      { ...LEAD, custom_fields: [{ uuid: 'LD_1', value: '' }] },
      { ...LEAD, products: [{ sku: 'CUP-01' }] },
      { ...LEAD, comment: 'typo for manager_comment' },
    ];

    for (const args of invalid) {
      const result = await harness.call('create_pipeline_card', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(harness.api.requests.length, 0);
  });

  it('says why a contact with nothing in it is refused', async () => {
    harness = await createHarness({ allowWrite: true });

    const result = await harness.call('create_pipeline_card', { contact: {} });

    assert.match(result.text, /Give a phone, an e-mail or buyer_id/);
  });
});

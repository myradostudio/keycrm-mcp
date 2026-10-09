/**
 * The live check itself, run as the command a person runs: scripts/live-check.mjs
 * is started as a child process and finds, through KEYCRM_API_URL, a local
 * stand-in instead of openapi.keycrm.app. The stand-in keeps a small account and
 * applies the filters it is sent, so the run passes; each rule of the script then
 * gets a case in which the run has to fail, or in which something must not be
 * sent or must not appear in the output.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

import { json, type FakeApi } from './support/fake-api.js';
import * as fixtures from './support/fixtures.js';
import { IDS } from './support/fixtures.js';
import { serve } from './support/http-bridge.js';
import { liveWorld, OTHER } from './support/live-world.js';
import { assertMatchesSpec } from './support/spec.js';

// Compiled to build-test/tests/live-check.test.js; the script and the server build are two levels up.
const SCRIPT = fileURLToPath(new URL('../../scripts/live-check.mjs', import.meta.url));

const KEY = 'live-check-api-key-do-not-print';
/** The checks of a run without arguments. A check that silently disappears changes this number. */
const READ_CHECKS = 20;
/** "A limit of up to 20 requests per minute for one API key" (docs.keycrm.app). */
const REQUESTS_PER_MINUTE = 20;
const CREATE = ['--create-card', '--pipeline-id', String(IDS.pipeline)];
/** The card the script creates is the fifth of the stand-in. */
const NEW_CARD = IDS.card + 4;

interface Run {
  readonly code: number | null;
  /** stdout and stderr together: nothing secret may be in either. */
  readonly output: string;
  readonly lines: readonly string[];
}

/** Runs the script against the stand-in. `input` is what the person would type, one answer per line. */
async function liveCheck(api: FakeApi, args: string[] = [], options: { input?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const bridge = await serve(api);
  try {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...getDefaultEnvironment(), KEYCRM_API_URL: bridge.url, ...(options.env ?? { KEYCRM_API_KEY: KEY }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (output += chunk));
    }
    child.stdin.end(options.input ?? '');
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    return { code, output, lines: output.split('\n').filter((line) => line !== '') };
  } finally {
    await bridge.close();
  }
}

const marked = (run: Run, mark: string) => run.lines.filter((line) => line.startsWith(`${mark}  `));
const sent = (api: FakeApi) => api.requests.map((request) => `${request.method} ${request.url.pathname}`);

describe('live check against a stand-in for the API', { concurrency: true }, () => {
  it('passes without arguments: PASS lines only, exit code 0, nothing but documented GET requests', async () => {
    const { api, cards } = liveWorld();
    const run = await liveCheck(api);

    assert.equal(run.code, 0, run.output);
    assert.match(run.lines[0] ?? '', /^KeyCRM live check, \d{4}-\d{2}-\d{2}, read tools only, nothing is created$/);
    assert.equal(run.lines[1], 'PASS  the server offers the 11 read tools and no write tool — read-only');
    assert.equal(marked(run, 'PASS').length, READ_CHECKS, run.output);
    assert.deepEqual(marked(run, 'FAIL'), []);
    assert.deepEqual(marked(run, 'SKIP'), []);
    assert.equal(run.lines.at(-1), 'All checks passed.');

    assert.ok(api.requests.every((request) => request.method === 'GET'), 'a run without arguments only reads');
    assert.equal(cards.length, 4, 'no card was added');
    // Every request is one the document describes, with the key in the header.
    for (const request of api.requests) {
      assertMatchesSpec(request);
      assert.equal(request.headers['authorization'], `Bearer ${KEY}`);
    }
  });

  it('fits into the requests KeyCRM allows per minute, so that no check waits or is refused', async () => {
    const { api } = liveWorld();
    await liveCheck(api);

    assert.equal(api.requests.length, 19);
    assert.ok(api.requests.length < REQUESTS_PER_MINUTE);
  });

  it('prints counts and field names, never the key or what the records hold; pipelines are named, they are needed to choose one', async () => {
    const { api } = liveWorld();
    const run = await liveCheck(api);

    assert.ok(!run.output.includes(KEY), 'the key must not be printed');
    const held = [
      fixtures.buyer.full_name,
      ...fixtures.buyer.phone,
      ...fixtures.buyer.email,
      'Петро Тестовий',
      '+380671234567',
      'petro@example.com',
      fixtures.user.full_name,
      fixtures.user.email,
      fixtures.order.manager_comment,
      'SHOP-1029',
      fixtures.card.title,
      fixtures.source.name,
      fixtures.orderStatus.name,
    ];
    for (const value of held) assert.ok(!run.output.includes(value), `the output holds a value from the account: ${value}`);
    assert.match(run.output, /^PASS  list_users: limit, page — users: 2; fields: id, full_name, username, email, role_id, status$/m);
    assert.match(run.output, new RegExp(`^PASS  list_pipelines: limit, page — pipelines: ${IDS.pipeline} "${fixtures.pipeline.name}", ${OTHER.pipeline} "Оптові запити"$`, 'm'));
  });

  it('asks for the key when the environment does not give it, hidden, and never prints it', async () => {
    const { api } = liveWorld();
    // The API repeats the Authorization header in a refusal, which the check prints.
    api.on('GET', '/v1/users', (request) => json({ message: `No access for ${request.headers['authorization']}` }, 403));
    const run = await liveCheck(api, [], { env: {}, input: `${KEY}\n` });

    assert.equal(run.code, 1);
    assert.equal(run.lines[0], 'KeyCRM API key (input is hidden): ');
    assert.ok(api.requests.length > 0 && api.requests.every((request) => request.headers['authorization'] === `Bearer ${KEY}`));
    assert.match(run.output, /^FAIL  list_users: limit, page — KeyCRM API error \(HTTP 403\): No access for Bearer \[redacted\]$/m);
    assert.ok(!run.output.includes(KEY), 'the key must not be printed');
    assert.equal(marked(run, 'PASS').length, READ_CHECKS - 1);
    assert.equal(run.lines.at(-1), '1 check(s) failed.');
  });

  describe('a filter the API does not apply, or matches in another form, is a FAIL and exit code 1', () => {
    const ORDERS_BY_KIND = 'FAIL  list_orders: status_ids, source_ids, payment_statuses, has_tracking_code, shipping_*';
    const CARDS_BY_KIND = 'FAIL  list_pipeline_cards: pipeline_id, status_ids, source_ids';
    const cases: [string, Parameters<typeof liveWorld>[0], string][] = [
      ['an ignored status of orders', { ignoredFilters: ['status_id'] }, `${ORDERS_BY_KIND} — status_ids was not applied`],
      ['an ignored tracking-code filter', { ignoredFilters: ['has_tracking_code'] }, `${ORDERS_BY_KIND} — has_tracking_code was not applied`],
      ['an ignored payment status', { ignoredFilters: ['payment_status'] }, `${ORDERS_BY_KIND} — payment_statuses was not applied`],
      ['an ignored source of orders', { ignoredFilters: ['source_id'] }, `${ORDERS_BY_KIND} — source_ids was not applied`],
      [
        'an ignored period of creation',
        { ignoredFilters: ['created_between'] },
        'FAIL  list_orders: created_from, created_to, sort — created_from and created_to were not applied: records of another time came back',
      ],
      [
        'a period that is read in another time zone, so that the order falls outside it',
        { unmatchedFilters: ['created_between'] },
        'FAIL  list_orders: created_from, created_to, sort — the order did not come back for the two minutes around its created_at: the period is not read as UTC, or not the way the server sends it',
      ],
      ['an ignored phone', { ignoredFilters: ['buyer_phone'] }, 'FAIL  list_orders: buyer_phone — buyer_phone was not applied: orders of other buyers came back'],
      [
        'a phone that is stored in another form than it is asked in',
        { unmatchedFilters: ['buyer_phone'] },
        'FAIL  list_orders: buyer_phone — the order of that buyer did not come back: buyer_phone is not matched the way KeyCRM stores it',
      ],
      ['an ignored e-mail of a buyer', { ignoredFilters: ['buyer_email'] }, 'FAIL  list_buyers: buyer_email — buyer_email was not applied: other buyers came back'],
      ['an ignored buyer id', { ignoredFilters: ['buyer_id'] }, 'FAIL  list_buyers: buyer_ids, include, limit, page — buyer_ids did not bring back that buyer alone'],
      // The filters of cards have the names of those of orders, so the same two settings break both lists.
      ['an ignored stage of a pipeline', { ignoredFilters: ['status_id'] }, `${CARDS_BY_KIND} — status_ids was not applied`],
      ['an ignored source of a card', { ignoredFilters: ['source_id'] }, `${CARDS_BY_KIND} — source_ids was not applied`],
    ];
    for (const [name, options, line] of cases) {
      it(name, async () => {
        const { api } = liveWorld(options);
        const run = await liveCheck(api);

        assert.equal(run.code, 1, run.output);
        assert.ok(marked(run, 'FAIL').includes(line), run.output);
        assert.match(run.lines.at(-1) ?? '', /^\d check\(s\) failed(, \d+ skipped)?\.$/);
        // A check that fails still sends only what the document describes.
        for (const request of api.requests) assertMatchesSpec(request);
      });
    }
  });

  describe('hides the phone and the e-mail of a buyer when KeyCRM repeats them in a refusal', () => {
    const REFUSAL = 'KeyCRM API error (HTTP 422): Nothing is found for [hidden]';

    it('for the buyer of the newest order', async () => {
      const { api } = liveWorld({ refusesContactFilters: true });
      const run = await liveCheck(api);

      assert.equal(run.code, 1);
      assert.deepEqual(marked(run, 'FAIL'), [
        `FAIL  list_orders: source_order_id, buyer_email, updated_from, updated_to — ${REFUSAL}`,
        `FAIL  list_orders: buyer_phone — ${REFUSAL}`,
        `FAIL  list_buyers: buyer_phone, created_*, updated_* — ${REFUSAL}`,
        `FAIL  list_buyers: buyer_email — ${REFUSAL}`,
      ]);
      for (const contact of ['+380671234567', 'petro@example.com']) assert.ok(!run.output.includes(contact), `the output holds ${contact}`);
    });

    it('for a buyer taken from the list of buyers, when the account has no orders', async () => {
      const { api } = liveWorld({ refusesContactFilters: true, withoutOrders: true });
      const run = await liveCheck(api);

      assert.equal(run.code, 1);
      assert.deepEqual(marked(run, 'FAIL'), [`FAIL  list_buyers: buyer_phone, created_*, updated_* — ${REFUSAL}`, `FAIL  list_buyers: buyer_email — ${REFUSAL}`]);
      for (const contact of [...fixtures.buyer.phone, ...fixtures.buyer.email]) assert.ok(!run.output.includes(contact), `the output holds ${contact}`);
    });
  });

  it('stops at once when KeyCRM rejects the key', async () => {
    const { api } = liveWorld();
    api.on('GET', /./, json({ message: 'Unauthenticated.' }, 401));
    const run = await liveCheck(api);

    assert.equal(run.code, 1);
    assert.deepEqual(marked(run, 'FAIL'), ['FAIL  list_order_statuses: limit, page — KeyCRM API error (HTTP 401): Unauthenticated.']);
    assert.match(run.output, /KeyCRM rejected the API key\. Check KEYCRM_API_KEY\./);
    assert.match(run.output, /^Stopped: the remaining checks were not run\.$/m);
    assert.equal(api.requests.length, 1, 'nothing more is sent with a rejected key');
  });

  it('stops and says to wait a minute when the rate limit is used up', async () => {
    const { api } = liveWorld();
    api.on('GET', '/v1/users', json({ message: 'Too Many Attempts.' }, 429));
    const run = await liveCheck(api);

    assert.equal(run.code, 1);
    assert.equal(marked(run, 'FAIL').length, 1);
    assert.match(run.output, /KeyCRM counts 20 requests per minute for one key\. Wait a minute and run the check again\./);
    assert.match(run.output, /^Stopped: the remaining checks were not run\.$/m);
    assert.equal(sent(api).at(-1), 'GET /v1/users');
  });

  it('reports an account without pipelines as skipped checks, not as failures', async () => {
    const { api } = liveWorld();
    api.on('GET', '/v1/pipelines', json({ message: 'Leads are not enabled' }, 400));
    const run = await liveCheck(api);

    assert.equal(run.code, 0, run.output);
    assert.deepEqual(marked(run, 'FAIL'), []);
    const skipped = marked(run, 'SKIP');
    assert.equal(skipped.length, 6, run.output);
    assert.match(skipped[0] ?? '', /^SKIP  list_pipelines: limit, page — pipelines are switched off in this account: KeyCRM API error \(HTTP 400\): Leads are not enabled$/);
    assert.ok(!sent(api).some((line) => line.includes('/pipelines/')), 'nothing more is asked about pipelines');
    assert.equal(run.lines.at(-1), 'All checks that ran passed; 6 skipped, see the SKIP lines.');
  });

  it('on an empty account passes what it can and skips what needs a record', async () => {
    const { api } = liveWorld({ empty: true });
    const run = await liveCheck(api);

    assert.equal(run.code, 0, run.output);
    assert.deepEqual(marked(run, 'FAIL'), []);
    assert.match(run.output, /^PASS  list_orders: include, sort, limit, page — the account has no orders$/m);
    assert.match(run.output, /^PASS  list_buyers: buyer_ids, include, limit, page — the account has no buyers$/m);
    assert.equal(marked(run, 'SKIP').length, 11, run.output);
    assert.match(run.lines.at(-1) ?? '', /^All checks that ran passed; 11 skipped, see the SKIP lines\.$/);
  });

  it('explains a key the server refuses to start with, without printing it', async () => {
    const { api } = liveWorld();
    const run = await liveCheck(api, [], { env: { KEYCRM_API_KEY: 'two words' } });

    assert.equal(run.code, 1);
    assert.match(run.output, /The server did not start\./);
    assert.match(run.output, /KEYCRM_API_KEY must be the API key alone/);
    assert.ok(!run.output.includes('two words'));
    assert.equal(api.requests.length, 0);
  });

  describe('--create-card', () => {
    it('says before creating that the card cannot be deleted through the API, then creates it, reads it back and finds it', async () => {
      const { api, cards } = liveWorld();
      const run = await liveCheck(api, CREATE, { input: 'yes\n' });

      assert.equal(run.code, 0, run.output);
      assert.match(run.lines[0] ?? '', /^KeyCRM live check, \d{4}-\d{2}-\d{2}, the write tool only: one card is created in pipeline 3 and stays there$/);
      assert.equal(run.lines[1], 'PASS  the server offers the 11 read tools and the write tool — write tool: create_pipeline_card');

      // The warning and the question come before anything is created.
      const warning = run.lines.indexOf(
        'KeyCRM has no API operation that deletes a pipeline card: its OpenAPI document (version 1.2.0) deletes only a tag or an attachment.',
      );
      const question = run.lines.indexOf('Type yes to create the card in pipeline 3: ');
      const creation = run.lines.findIndex((line) => line.startsWith('PASS  create_pipeline_card'));
      assert.ok(warning > 0 && warning < question && question < creation, run.output);

      assert.equal(marked(run, 'PASS').length, 4, run.output);
      assert.deepEqual(marked(run, 'FAIL'), []);
      const title = `MCP live check ${new Date().toISOString().slice(0, 10)}: delete this card`;
      assert.deepEqual(run.lines.slice(-3), [
        `Card ${NEW_CARD} is now in pipeline 3 and the API cannot delete it.`,
        `Look for "${title}" in KeyCRM and delete it by hand.`,
        'All checks passed.',
      ]);

      // One card, in the pipeline that was named, with nothing that points at a real person or manager.
      assert.equal(cards.length, 5);
      assert.deepEqual(sent(api), ['POST /v1/pipelines/cards', `GET /v1/pipelines/cards/${NEW_CARD}`, 'GET /v1/pipelines/cards']);
      const { communicate_at: communicateAt, ...body } = api.requests[0]?.body as Record<string, any>;
      assert.match(communicateAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.deepEqual(body, {
        title,
        manager_comment: 'Created by the live check of keycrm-mcp. Nobody is waiting for an answer: delete this card.',
        pipeline_id: IDS.pipeline,
        contact: { full_name: 'MCP live check', email: 'live-check@example.com' },
        utm_source: 'keycrm-mcp',
        utm_medium: 'live-check',
        utm_campaign: 'live-check',
        utm_term: 'live-check',
        utm_content: 'live-check',
      });
      for (const request of api.requests) assertMatchesSpec(request);
      assert.ok(!run.output.includes(KEY));
    });

    it('creates nothing unless the answer is yes', async () => {
      const { api, cards } = liveWorld();
      const run = await liveCheck(api, CREATE, { input: '\n' });

      assert.equal(run.code, 0, run.output);
      assert.deepEqual(marked(run, 'SKIP'), ['SKIP  create_pipeline_card, get_pipeline_card, list_pipeline_cards — not confirmed, nothing was created']);
      assert.equal(cards.length, 4);
      assert.equal(api.requests.length, 0);
      assert.ok(!run.output.includes('delete it by hand'));
    });

    it('fails when the card lands in another pipeline than the one that was named, and still says where it is', async () => {
      const { api } = liveWorld({ ignoresPipelineOfNewCard: true });
      const run = await liveCheck(api, ['--create-card', '--pipeline-id', String(OTHER.pipeline)], { input: 'yes\n' });

      assert.equal(run.code, 1);
      assert.deepEqual(marked(run, 'FAIL'), [
        `FAIL  get_pipeline_card: the new card holds what was sent, in the pipeline that was asked for — the card is in pipeline ${IDS.pipeline}, not in ${OTHER.pipeline}`,
        'FAIL  list_pipeline_cards: the new card is found by its pipeline and the time of its creation — the new card is not among the cards created in these minutes',
      ]);
      assert.match(run.output, new RegExp(`^Card ${NEW_CARD} is now in pipeline ${OTHER.pipeline} and the API cannot delete it\\.$`, 'm'));
      assert.equal(run.lines.at(-1), '2 check(s) failed.');
    });

    it('fails without leaving a card when KeyCRM refuses the pipeline', async () => {
      const { api, cards } = liveWorld();
      const run = await liveCheck(api, ['--create-card', '--pipeline-id', '999'], { input: 'yes\n' });

      assert.equal(run.code, 1);
      assert.equal(marked(run, 'FAIL').length, 1);
      assert.match(run.output, /^FAIL  create_pipeline_card: .* — KeyCRM API error \(HTTP 403\): Wrong arguments or pipelines are not activated$/m);
      assert.equal(cards.length, 4);
      assert.ok(!run.output.includes('delete it by hand'), 'nothing was created, so there is nothing to delete');
      assert.deepEqual(sent(api), ['POST /v1/pipelines/cards']);
    });

    // A gateway error, and the rate limit of KeyCRM: after either nobody knows whether the card was made.
    for (const status of [502, 429]) {
      it(`says that a card may exist when its creation got no definite answer (HTTP ${status}), and sends nothing after it`, async () => {
        const { api } = liveWorld();
        api.on('POST', '/v1/pipelines/cards', json({ message: 'No answer' }, status));
        const run = await liveCheck(api, CREATE, { input: 'yes\n' });

        assert.equal(run.code, 1);
        assert.match(run.output, /It is unknown whether KeyCRM created the record/);
        assert.match(run.output, /^A card MAY EXIST in pipeline 3: KeyCRM gave no definite answer when it was created\.$/m);
        assert.deepEqual(sent(api), ['POST /v1/pipelines/cards']);
        assert.equal(run.lines.at(-1), '1 check(s) failed.');
      });
    }

    it('says that a card may exist when KeyCRM answers with success but without the id of the card', async () => {
      const { api } = liveWorld();
      api.on('POST', '/v1/pipelines/cards', json({}, 201));
      const run = await liveCheck(api, CREATE, { input: 'yes\n' });

      assert.equal(run.code, 1);
      assert.match(run.output, /^FAIL  create_pipeline_card: .* — no card id came back: KeyCRM answered with success but without a card id\./m);
      assert.match(run.output, /^A card MAY EXIST in pipeline 3: KeyCRM gave no definite answer when it was created\.$/m);
      assert.match(run.output, /^Look for "MCP live check \d{4}-\d{2}-\d{2}: delete this card" in KeyCRM and delete it by hand\.$/m);
      assert.deepEqual(sent(api), ['POST /v1/pipelines/cards']);
    });
  });

  describe('a mistake in how the script is started ends it with exit code 2 before anything is sent', () => {
    const withKey = { KEYCRM_API_KEY: KEY };
    const cases: [string, string[], Record<string, string>, string, RegExp][] = [
      ['an unknown argument, which is not repeated: it may be a key', ['--key', KEY], withKey, '', /^The script takes --create-card together with --pipeline-id/],
      ['--create-card without a pipeline', ['--create-card'], withKey, 'yes\n', /^--create-card needs --pipeline-id and a number/],
      ['--pipeline-id without --create-card', ['--pipeline-id', '3'], withKey, '', /^--pipeline-id is used with --create-card only/],
      ['a pipeline id that is not a number', ['--create-card', '--pipeline-id', 'sales'], withKey, 'yes\n', /^The script takes --create-card together with --pipeline-id/],
      ['no key', [], {}, '\n', /^No API key was given/],
    ];
    for (const [name, args, env, input, message] of cases) {
      it(name, async () => {
        const { api, cards } = liveWorld();
        const run = await liveCheck(api, args, { env, input });

        assert.equal(run.code, 2, run.output);
        assert.match(run.lines.at(-1) ?? '', message);
        assert.equal(api.requests.length, 0);
        assert.equal(cards.length, 4);
        assert.deepEqual(marked(run, 'PASS'), []);
        assert.ok(!run.output.includes(KEY));
      });
    }
  });

  describe('documentation', () => {
    const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

    for (const file of ['README.md', 'README.uk.md']) {
      it(`${file} names the live-check command, the two arguments of the write check, and no npm script that does not exist`, () => {
        const text = read(file);
        const named = [...text.matchAll(/npm run ([a-z:-]+)/g)].map((match) => match[1] ?? '');
        for (const name of named) assert.ok(name in scripts, `${file} names \`npm run ${name}\`, which package.json does not have`);
        assert.ok(named.includes('live-check'), `${file} does not name \`npm run live-check\``);
        assert.ok(text.includes('node scripts/live-check.mjs --create-card --pipeline-id'), `${file} does not show how a card is created`);
      });
    }

    it('both READMEs say that a card cannot be deleted through the API', () => {
      assert.match(read('README.md'), /no API operation that deletes a pipeline card/);
      assert.match(read('README.uk.md'), /немає операції API, яка видаляє картку воронки/);
    });

    it('the npm command starts the script without arguments: creating a card is never one npm word away', () => {
      assert.equal(scripts['live-check'], 'npm run build && node scripts/live-check.mjs');
      assert.deepEqual(
        Object.keys(scripts).filter((name) => name.startsWith('live-check')),
        ['live-check'],
      );
    });
  });
});

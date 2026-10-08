/** Tool metadata, annotations, server instructions and error rendering. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { z } from 'zod';

import { KeycrmClient } from '../src/client.js';
import { runTool, selectTools } from '../src/server.js';
import { defineTool, READ_ONLY } from '../src/tools/types.js';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';
import { FakeApi, json, page } from './support/fake-api.js';
import { IDS } from './support/fixtures.js';
import { API_KEY, createHarness, testConfig, type Harness } from './support/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('server metadata', () => {
  it('introduces itself with its name, version and read-only instructions', async () => {
    harness = await createHarness();

    assert.deepEqual(
      { name: harness.mcp.getServerVersion()?.name, version: harness.mcp.getServerVersion()?.version },
      { name: SERVER_NAME, version: SERVER_VERSION },
    );
    const instructions = harness.mcp.getInstructions() ?? '';
    assert.match(instructions, /Unofficial/);
    assert.match(instructions, /is UTC/);
    assert.match(instructions, /20 requests per minute/);
    assert.match(instructions, /read-only mode/);
    assert.doesNotMatch(instructions, /write tool is enabled/);
  });

  it('asks for confirmation in the instructions when the write tool is enabled', async () => {
    harness = await createHarness({ allowWrite: true });

    const instructions = harness.mcp.getInstructions() ?? '';
    assert.match(instructions, /write tool is enabled/);
    assert.match(instructions, /repeating the call adds a second one/);
    assert.match(instructions, /explicit confirmation from the user/);
  });

  it('describes every tool: unique snake_case name, title, description, object schema', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z]+(_[a-z]+)+$/, tool.name);
      assert.ok((tool.title ?? '').length > 0, `${tool.name}: title`);
      assert.ok((tool.description ?? '').length >= 80, `${tool.name}: description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: input schema`);
    }
  });

  it('documents every argument of every tool', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, property] of Object.entries(properties)) {
        assert.ok((property.description ?? '').length > 0, `${tool.name}.${name} has no description`);
      }
    }
  });
});

describe('annotations', () => {
  it('marks read tools as read-only and idempotent', async () => {
    harness = await createHarness();

    const { tools } = await harness.mcp.listTools();

    assert.equal(tools.length, 11);
    for (const tool of tools) {
      assert.deepEqual(
        tool.annotations,
        { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        tool.name,
      );
    }
  });

  it('marks creating a card as a write that adds and is not idempotent', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();
    const tool = tools.find((candidate) => candidate.name === 'create_pipeline_card');

    assert.deepEqual(tool?.annotations, {
      title: 'Create a pipeline card (lead)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('no read tool is ever backed by anything but GET', async () => {
    // Guards the read-only promise at the source: a read tool that sends a POST fails here.
    const api = new FakeApi();
    api.on('GET', /.*/, page([{ id: 1 }]));
    harness = await createHarness({}, api);
    const sampleArguments: Record<string, Record<string, unknown>> = {
      get_order: { order_id: IDS.order },
      get_buyer: { buyer_id: IDS.buyer },
      list_pipeline_statuses: { pipeline_id: IDS.pipeline },
      get_pipeline_card: { card_id: IDS.card },
    };

    for (const tool of selectTools(testConfig())) {
      const result = await harness.call(tool.name, sampleArguments[tool.name] ?? {});
      assert.equal(result.isError, false, `${tool.name}: ${result.text}`);
    }

    assert.equal(api.requests.length, 11);
    assert.deepEqual([...new Set(api.requests.map((request) => request.method))], ['GET']);
  });
});

describe('warnings', () => {
  it('the write tool says that a repeated call makes a second card', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();
    const description = tools.find((tool) => tool.name === 'create_pipeline_card')?.description ?? '';

    assert.match(description, /not idempotent: repeating it creates a second card/);
    assert.match(description, /explicit confirmation from the user/);
  });

  it('tools that return personal data say so', async () => {
    harness = await createHarness();

    const { tools } = await harness.mcp.listTools();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';

    assert.match(description('get_order'), /customer contact data/);
    assert.match(description('get_buyer'), /personal data/);
    assert.match(description('get_pipeline_card'), /customer contact data/);
  });
});

describe('error rendering', () => {
  it('returns API errors as isError results with the API message', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/v1/order', json({ message: 'Ключ заблоковано' }, 403));

    const result = await harness.call('list_orders');

    assert.equal(result.isError, true);
    assert.match(result.text, /^KeyCRM API error \(HTTP 403\): Ключ заблоковано\n/);
    assert.ok(!result.text.includes(API_KEY));
  });

  it('never exposes a stack trace, whatever a handler throws', async () => {
    const config = testConfig();
    const context = { config, client: new KeycrmClient({ config, fetch: new FakeApi().fetch }) };
    const failing = (thrown: unknown) =>
      defineTool({
        name: 'failing_tool',
        title: 'Failing tool',
        description: 'Always fails.',
        access: 'read',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
        handler: async () => {
          throw thrown;
        },
      });

    const fromError = await runTool(failing(new TypeError("Cannot read properties of undefined (reading 'x')")), {}, context);
    const fromString = await runTool(failing('plain string'), {}, context);

    assert.deepEqual(fromError, {
      content: [{ type: 'text', text: "Cannot read properties of undefined (reading 'x')" }],
      isError: true,
    });
    assert.deepEqual(fromString, { content: [{ type: 'text', text: 'Unexpected error.' }], isError: true });
    assert.doesNotMatch(JSON.stringify(fromError), /\bat .*\.js/);
  });
});

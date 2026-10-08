/** Wires a real MCP client to the server in memory, with the KeyCRM API replaced by `FakeApi`. */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { KeycrmClient } from '../../src/client.js';
import type { Config } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { FakeApi } from './fake-api.js';

export const API_KEY = 'test-api-key-0123456789abcdef';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: 'https://openapi.keycrm.test',
    apiKey: API_KEY,
    allowWrite: false,
    timeoutMs: 5_000,
    notices: [],
    ...overrides,
  };
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface Harness {
  readonly api: FakeApi;
  readonly config: Config;
  readonly mcp: Client;
  /** Calls a tool through MCP and returns its text content. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Calls a tool, asserts success and parses the JSON part of the result. */
  callJson<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export async function createHarness(overrides: Partial<Config> = {}, api = new FakeApi()): Promise<Harness> {
  const config = testConfig(overrides);
  // The pacing of requests is tested on its own; here every request finds the limit fresh.
  let clock = 0;
  const client = new KeycrmClient({ config, fetch: api.fetch, now: () => (clock += 60_000), sleep: async () => undefined });
  const server = createServer({ config, client });
  const mcp = new Client({ name: 'test-harness', version: '1.0.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const result = await mcp.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    return { text, isError: result.isError === true };
  };

  return {
    api,
    config,
    mcp,
    call,
    callJson: async (name, args) => {
      const result = await call(name, args);
      if (result.isError) throw new Error(`Tool ${name} failed: ${result.text}`);
      // A result is either pure JSON or a note, a blank line, then JSON.
      const start = result.text.search(/^[{[]/m);
      return JSON.parse(result.text.slice(start));
    },
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

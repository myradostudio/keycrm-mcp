/**
 * Builds the MCP server: picks the tools allowed by the configuration and wires
 * each one to the SDK with uniform result rendering and error handling.
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';

import type { KeycrmClient } from './client.js';
import type { Config } from './config.js';
import { describeError } from './errors.js';
import { readTools } from './tools/read.js';
import type { AnyTool, ToolContext, ToolOutput } from './tools/types.js';
import { writeTools } from './tools/write.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface ServerDependencies {
  readonly config: Config;
  readonly client: KeycrmClient;
}

const READ_ONLY_MODE =
  'This server runs in read-only mode: it cannot create or change anything in KeyCRM. If the user asks to register a lead, explain that the operator has to start the server with KEYCRM_ALLOW_WRITE=1.';

const WRITE_MODE =
  'The write tool is enabled: create_pipeline_card adds a lead card that managers will see and act on, and repeating the call adds a second one. Never create a card on your own initiative: state who the lead is and what the card will say, and get explicit confirmation from the user first.';

function instructions(config: Config): string {
  return [
    'Unofficial MCP server for KeyCRM (keycrm.app), a Ukrainian CRM for trade and service businesses: orders, buyers, and pipelines with lead cards. It acts with one API key of one KeyCRM account.',
    'Every date and time KeyCRM returns is UTC. Convert to the local time of the user when talking to them (Kyiv is UTC+2 in winter, UTC+3 in summer). Date arguments take ISO 8601 with a UTC offset and are converted to UTC by the server.',
    'Money amounts are plain numbers in the currency of the order source, not in minor units.',
    'List tools return compact summaries and a pagination block; use next_page to get the next page and the matching get_* tool for full details. Related data (buyer, status name, products) comes only when asked for with `include`.',
    'KeyCRM allows 20 requests per minute for one API key: prefer one filtered call to many small ones.',
    config.allowWrite ? WRITE_MODE : READ_ONLY_MODE,
  ].join('\n');
}

/** Read tools always; write tools only when the operator opted in. */
export function selectTools(config: Config): readonly AnyTool[] {
  return config.allowWrite ? [...readTools, ...writeTools] : readTools;
}

function render(output: ToolOutput): CallToolResult {
  const parts: string[] = [];
  if (output.note !== undefined) parts.push(output.note);
  if (output.data !== undefined && output.data !== null) {
    parts.push(typeof output.data === 'string' ? output.data : JSON.stringify(output.data, null, 2));
  }
  if (parts.length === 0) parts.push('The KeyCRM API returned an empty response.');
  return { content: [{ type: 'text', text: parts.join('\n\n') }] };
}

/** Runs a tool handler. Failures become `isError` results with a plain message, never a stack trace. */
export async function runTool(tool: AnyTool, args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult> {
  try {
    return render(await tool.handler(args, context));
  } catch (error) {
    return { content: [{ type: 'text', text: describeError(error) }], isError: true };
  }
}

export function createServer({ config, client }: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'KeyCRM (unofficial)', version: SERVER_VERSION },
    { instructions: instructions(config) },
  );
  const context: ToolContext = { config, client };

  for (const tool of selectTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args) => runTool(tool, args, context),
    );
  }

  return server;
}

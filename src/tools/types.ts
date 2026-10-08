import type { z } from 'zod';

import type { KeycrmClient } from '../client.js';
import type { Config } from '../config.js';

export interface ToolContext {
  readonly client: KeycrmClient;
  readonly config: Config;
}

/** What a tool handler returns; `server.ts` renders it as MCP text content. */
export interface ToolOutput {
  /** Short guidance for the model, placed before the data. */
  readonly note?: string;
  /** JSON-serialisable data. */
  readonly data?: unknown;
}

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** `write` tools are registered only when KEYCRM_ALLOW_WRITE=1. */
  readonly access: 'read' | 'write';
  readonly inputSchema: Schema;
  readonly annotations: ToolAnnotations;
  readonly handler: (args: z.infer<Schema>, context: ToolContext) => Promise<ToolOutput>;
}

/** A tool with its argument type erased, so tools with different schemas fit in one list. */
export type AnyTool = ToolDefinition<z.ZodObject>;

/** Identity helper that infers the handler's argument type from `inputSchema`. */
export function defineTool<Schema extends z.ZodObject>(tool: ToolDefinition<Schema>): AnyTool {
  return tool as unknown as AnyTool;
}

/** Every tool talks to an external service, hence `openWorldHint: true` everywhere. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Adds a record to the CRM that managers will see and act on. Nothing existing
 * is changed, so the tool is not flagged destructive; calling it twice makes two
 * records, so it is not idempotent either.
 */
export const ADDITIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

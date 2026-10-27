import { z } from 'zod';

/**
 * Tools registered here are validated against their Zod schema before the
 * handler runs when called through trace(). Which agent may call which tool is
 * decided by the YAML policy, not here.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
}

/** Thrown when a tool's input does not match its schema. */
export class ToolInputError extends Error {
  constructor(public readonly toolName: string, public readonly issues: string[]) {
    super(`Tool input validation failed for "${toolName}": ${issues.join('; ')}`);
    this.name = 'ToolInputError';
  }
}

const toolRegistry = new Map<string, ToolDefinition>();

export function registerTool<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
  toolRegistry.set(definition.name, definition as ToolDefinition);
}

export function hasRegisteredTool(name: string): boolean {
  return toolRegistry.has(name);
}

export function getRegisteredTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

/** Validates the input against the tool's schema, then runs the handler. */
export async function callTool(toolName: string, input: unknown): Promise<unknown> {
  const tool = toolRegistry.get(toolName);
  if (!tool) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolInputError(toolName, parsed.error.issues.map(e => `${e.path.join('.') || '(input)'}: ${e.message}`));
  }
  return tool.handler(parsed.data);
}

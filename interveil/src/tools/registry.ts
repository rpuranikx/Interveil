import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../ws/broadcaster.js';

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
}

export type PermissionType = 'read' | 'write' | 'execute' | 'delete' | '*';

export interface AccessCondition {
  mustEqual?: unknown;
  mustNotEqual?: unknown;
  mustContain?: string;
  mustMatch?: string;
  mustBeOneOf?: unknown[];
}

export interface ToolRule {
  tool: string;
  allow?: PermissionType[];
  deny?: PermissionType[];
  conditions?: Record<string, AccessCondition>;
}

export interface AgentPolicy {
  agentId: string;
  rules: ToolRule[];
}

const toolRegistry = new Map<string, ToolDefinition>();
const policies: AgentPolicy[] = [];

export function registerTool<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
  toolRegistry.set(definition.name, definition as ToolDefinition);
  console.log(`[Interveil] Tool registered: ${definition.name}`);
}

export function definePolicy(policy: AgentPolicy): void {
  const existing = policies.findIndex(p => p.agentId === policy.agentId);
  if (existing >= 0) {
    policies[existing] = policy;
  } else {
    policies.push(policy);
  }
  console.log(`[Interveil] Policy defined for agent: ${policy.agentId}`);
}

export function exportPolicy(filePath?: string): string {
  const json = JSON.stringify(policies, null, 2);
  if (filePath) {
    writeFileSync(filePath, json, 'utf-8');
  }
  return json;
}

export function importPolicy(filePath: string): void {
  const raw = readFileSync(filePath, 'utf-8');
  const loaded = JSON.parse(raw) as AgentPolicy[];
  policies.push(...loaded);
}

function evaluateCondition(value: unknown, condition: AccessCondition): boolean {
  if (condition.mustEqual !== undefined && value !== condition.mustEqual) return false;
  if (condition.mustNotEqual !== undefined && value === condition.mustNotEqual) return false;
  if (condition.mustContain !== undefined) {
    if (typeof value !== 'string' || !value.includes(condition.mustContain)) return false;
  }
  if (condition.mustMatch !== undefined) {
    if (typeof value !== 'string' || !new RegExp(condition.mustMatch).test(value)) return false;
  }
  if (condition.mustBeOneOf !== undefined) {
    if (!condition.mustBeOneOf.includes(value)) return false;
  }
  return true;
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

interface CheckResult {
  allowed: boolean;
  violatedRule?: string;
  allowedPermissions?: PermissionType[];
}

export function checkToolAccess(
  toolName: string,
  agentId: string,
  input: unknown,
  requestedPermissions: PermissionType[] = ['execute']
): CheckResult {
  const agentPolicy = policies.find(p => p.agentId === agentId);
  if (!agentPolicy) return { allowed: true };

  const toolRule = agentPolicy.rules.find(r => r.tool === toolName || r.tool === '*');
  if (!toolRule) return { allowed: true };

  if (toolRule.conditions) {
    for (const [path, condition] of Object.entries(toolRule.conditions)) {
      const value = getNestedValue(input, path);
      if (!evaluateCondition(value, condition)) {
        return {
          allowed: false,
          violatedRule: `Condition failed: ${path}`,
          allowedPermissions: toolRule.allow ?? [],
        };
      }
    }
  }

  const denied = toolRule.deny ?? [];
  for (const perm of requestedPermissions) {
    if (denied.includes('*') || denied.includes(perm)) {
      return {
        allowed: false,
        violatedRule: `Permission denied: ${perm}`,
        allowedPermissions: toolRule.allow ?? [],
      };
    }
  }

  return { allowed: true, allowedPermissions: toolRule.allow ?? [] };
}

export async function callTool(
  toolName: string,
  input: unknown,
  agentId: string,
  sessionId?: string
): Promise<unknown> {
  const tool = toolRegistry.get(toolName);

  if (!tool) {
    const event = {
      event_id: uuidv4(),
      session_id: sessionId ?? 'unknown',
      step_index: 0,
      step_type: 'CUSTOM',
      input: { tool_name: toolName, input },
      output: null,
      timestamp: new Date().toISOString(),
      metadata: { warning: `TOOL_UNREGISTERED: ${toolName}` },
    };
    broadcast(event as unknown as Record<string, unknown>);
    throw new Error(`Tool not registered: ${toolName}`);
  }

  const accessCheck = checkToolAccess(toolName, agentId, input, ['execute']);
  if (!accessCheck.allowed) {
    const event = {
      event_id: uuidv4(),
      session_id: sessionId ?? 'unknown',
      step_index: 0,
      step_type: 'TOOL_PERMISSION_DENIED',
      input: { tool_name: toolName, input_payload: input },
      output: null,
      timestamp: new Date().toISOString(),
      metadata: {
        tool_name: toolName,
        agent_id: agentId,
        violated_rule: accessCheck.violatedRule,
        allowed_permissions: accessCheck.allowedPermissions,
      },
    };
    broadcast(event as unknown as Record<string, unknown>);
    throw new Error(`Tool permission denied: ${accessCheck.violatedRule}`);
  }

  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Tool input validation failed: ${parsed.error.message}`);
  }

  return tool.handler(parsed.data);
}

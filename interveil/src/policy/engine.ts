import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../ws/broadcaster.js';

export interface PolicyCondition {
  tool?: string;
  [key: string]: unknown;
}

export interface PolicyRule {
  id: string;
  condition: PolicyCondition;
  action: 'block' | 'allow' | 'allow_and_audit' | 'require_approval' | 'halt_agent';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  message?: string;
}

export interface AgentPolicySpec {
  id: string;
  rules: PolicyRule[];
}

export interface PolicyEnvironment {
  strictMode?: boolean;
  haltOnCritical?: boolean;
}

export interface PolicyFile {
  version: string;
  agents?: AgentPolicySpec[];
  environments?: Record<string, PolicyEnvironment>;
}

export class PolicyViolationError extends Error {
  constructor(
    public readonly ruleId: string,
    public readonly agentId: string,
    public readonly toolName: string,
    public readonly severity: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

let activePolicies: PolicyFile = { version: '1.0' };
const currentEnvironment = process.env.NODE_ENV === 'production' ? 'production' : 'staging';

export function loadPolicyFile(filePath: string): void {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    activePolicies = parseYaml(raw) as PolicyFile;
    console.log(`[Interveil] Policy loaded from ${filePath}`);
  } catch (err) {
    console.warn(`[Interveil] Failed to load policy file: ${(err as Error).message}`);
  }
}

export function validatePolicyFile(filePath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const policy = parseYaml(raw) as PolicyFile;
    if (!policy.version) errors.push('Missing required field: version');
    if (policy.agents) {
      policy.agents.forEach((agent, i) => {
        if (!agent.id) errors.push(`Agent at index ${i} missing id`);
        if (!Array.isArray(agent.rules)) errors.push(`Agent ${agent.id ?? i} missing rules array`);
      });
    }
  } catch (err) {
    errors.push(`Parse error: ${(err as Error).message}`);
  }
  return { valid: errors.length === 0, errors };
}

export interface PolicyEvalResult {
  action: 'allow' | 'block' | 'allow_and_audit' | 'require_approval' | 'halt_agent';
  rule?: PolicyRule;
  sessionId?: string;
}

export async function evaluatePolicy(
  agentId: string,
  toolName: string,
  input: unknown,
  sessionId?: string
): Promise<PolicyEvalResult> {
  const agentSpec = activePolicies.agents?.find(a => a.id === agentId);
  if (!agentSpec) return { action: 'allow' };

  const envConfig = activePolicies.environments?.[currentEnvironment] ?? {};

  for (const rule of agentSpec.rules) {
    if (!matchesCondition(rule.condition, toolName, input)) continue;

    const sid = sessionId ?? uuidv4();

    if (rule.action === 'block' || rule.action === 'halt_agent') {
      const event = {
        event_id: uuidv4(),
        session_id: sid,
        step_index: 0,
        step_type: 'POLICY_VIOLATION',
        input: { tool_name: toolName, input },
        output: null,
        timestamp: new Date().toISOString(),
        metadata: {
          rule_id: rule.id,
          agent_id: agentId,
          severity: rule.severity,
          message: rule.message ?? `Policy rule ${rule.id} triggered`,
          environment: currentEnvironment,
        },
      };
      broadcast(event);

      if (envConfig.haltOnCritical && rule.severity === 'critical') {
        const msg = `[Interveil] CRITICAL POLICY VIOLATION: ${rule.message ?? rule.id}`;
        console.error(msg);
        throw new PolicyViolationError(
          rule.id,
          agentId,
          toolName,
          rule.severity ?? 'critical',
          msg,
        );
      }

      return { action: rule.action, rule, sessionId: sid };
    }

    if (rule.action === 'allow_and_audit') {
      const event = {
        event_id: uuidv4(),
        session_id: sid,
        step_index: 0,
        step_type: 'POLICY_AUDIT',
        input: { tool_name: toolName, input },
        output: null,
        timestamp: new Date().toISOString(),
        metadata: { rule_id: rule.id, agent_id: agentId, severity: rule.severity },
      };
      broadcast(event);
      return { action: 'allow_and_audit', rule, sessionId: sid };
    }

    return { action: rule.action, rule, sessionId: sid };
  }

  return { action: 'allow' };
}

function matchesCondition(condition: PolicyCondition, toolName: string, input: unknown): boolean {
  if (condition.tool && condition.tool !== toolName) return false;

  for (const [key, expected] of Object.entries(condition)) {
    if (key === 'tool') continue;
    const value = getNestedValue(input, key);

    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      const constraint = expected as Record<string, unknown>;
      if (constraint.greaterThan !== undefined && !(Number(value) > Number(constraint.greaterThan))) return false;
      if (constraint.lessThan !== undefined && !(Number(value) < Number(constraint.lessThan))) return false;
      if (constraint.equals !== undefined && value !== constraint.equals) return false;
    } else {
      if (value !== expected) return false;
    }
  }

  return true;
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

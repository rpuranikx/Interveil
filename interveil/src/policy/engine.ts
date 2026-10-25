import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ── Schema ───────────────────────────────────────────────────────────────────
// Every object is strict: an unknown key (e.g. a typo like `acton`) is an error,
// not something silently ignored. A policy that does not validate never loads.

const ACTIONS = ['block', 'allow', 'allow_and_audit', 'require_approval', 'halt_agent'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const isValidRegex = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const ConstraintSchema = z.object({
  equals: ScalarSchema.optional(),
  notEquals: ScalarSchema.optional(),
  greaterThan: z.number().optional(),
  lessThan: z.number().optional(),
  /** Substring match on string values. */
  contains: z.string().optional(),
  /** JavaScript regular expression tested against string values. */
  matches: z.string().refine(isValidRegex, 'matches must be a valid regular expression').optional(),
  oneOf: z.array(ScalarSchema).min(1).optional(),
  /** Makes `contains` and `matches` case-insensitive. */
  ignoreCase: z.boolean().optional(),
}).strict().refine(c => Object.keys(c).length > 0, 'constraint must set at least one of equals, notEquals, greaterThan, lessThan, contains, matches, oneOf');

const ConditionSchema = z.object({
  /** One tool name, or a list of names any of which matches. */
  tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
}).catchall(z.union([ScalarSchema, ConstraintSchema]));

const RuleSchema = z.object({
  id: z.string().min(1),
  condition: ConditionSchema,
  action: z.enum(ACTIONS),
  severity: z.enum(SEVERITIES).optional(),
  message: z.string().optional(),
}).strict();

const AgentSchema = z.object({
  /** Agent id from `trace({ agentId })`, or `*` for rules that apply to every agent. */
  id: z.string().min(1),
  rules: z.array(RuleSchema),
}).strict();

const PolicyFileSchema = z.object({
  version: z.union([z.string(), z.number()]).transform(String),
  /** Action when no rule matches. Set to `block` for deny-by-default. */
  defaultAction: z.enum(['allow', 'block']).default('allow'),
  agents: z.array(AgentSchema).default([]),
  environments: z.record(z.object({
    /** Escalate `block` rules with severity `critical` to `halt_agent`. */
    haltOnCritical: z.boolean().optional(),
  }).strict()).optional(),
  alerts: z.object({
    webhooks: z.array(z.object({
      url: z.string().url(),
      /** Event types to send. Defaults to violations only. */
      events: z.array(z.enum(['POLICY_VIOLATION', 'POLICY_AUDIT'])).default(['POLICY_VIOLATION']),
      /** Name of an environment variable holding the HMAC signing secret (never the secret itself). */
      secretEnv: z.string().min(1).optional(),
    }).strict()).default([]),
  }).strict().optional(),
}).strict();

export type PolicyFile = z.infer<typeof PolicyFileSchema>;
export type WebhookConfig = NonNullable<PolicyFile['alerts']>['webhooks'][number];
export type AgentPolicySpec = z.infer<typeof AgentSchema>;
export type PolicyRule = z.infer<typeof RuleSchema>;
export type PolicyCondition = z.infer<typeof ConditionSchema>;

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

/** Thrown when a policy file cannot be read, parsed, or validated. */
export class PolicyLoadError extends Error {
  constructor(public readonly source: string, public readonly errors: string[]) {
    super(`Invalid policy ${source}:\n  - ${errors.join('\n  - ')}`);
    this.name = 'PolicyLoadError';
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

let activePolicy: PolicyFile = { version: '1.0', defaultAction: 'allow', agents: [] };
let activeFile: string | undefined;
const currentEnvironment = process.env.NODE_ENV === 'production' ? 'production' : 'staging';

function validate(raw: unknown, source: string): PolicyFile {
  const parsed = PolicyFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyLoadError(source, parsed.error.errors.map(e => `${e.path.join('.') || '(root)'}: ${e.message}`));
  }
  return parsed.data;
}

function readPolicyFile(filePath: string): PolicyFile {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new PolicyLoadError(filePath, [(err as Error).message]);
  }
  return validate(raw, filePath);
}

/**
 * Loads and activates a YAML policy file. Throws PolicyLoadError if the file is
 * missing, malformed, or fails validation — the previous policy stays active and
 * callers must not proceed as if the new policy were enforced.
 */
export function loadPolicyFile(filePath: string): PolicyFile {
  activePolicy = readPolicyFile(filePath);
  activeFile = filePath;
  return activePolicy;
}

/** Path of the loaded policy file, if the active policy came from one. */
export function activePolicyFile(): string | undefined {
  return activeFile;
}

/** Validates and activates a policy object (same rules as loadPolicyFile). */
export function setPolicy(policy: unknown): PolicyFile {
  activePolicy = validate(policy, '(object)');
  activeFile = undefined;
  return activePolicy;
}

export function activeWebhooks(): WebhookConfig[] {
  return activePolicy.alerts?.webhooks ?? [];
}

export function validatePolicyFile(filePath: string): { valid: boolean; errors: string[] } {
  try {
    readPolicyFile(filePath);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: err instanceof PolicyLoadError ? err.errors : [(err as Error).message] };
  }
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface PolicyEvalResult {
  action: PolicyRule['action'];
  rule?: PolicyRule;
}

/**
 * Returns the action of the first matching rule. Rules for the exact agent id are
 * checked before `*` rules; if nothing matches, the policy's defaultAction applies.
 * Pure: emitting trace events for the result is the caller's job.
 */
export async function evaluatePolicy(agentId: string, toolName: string, input: unknown): Promise<PolicyEvalResult> {
  const agents = activePolicy.agents;
  const rules = [
    ...(agents.find(a => a.id === agentId)?.rules ?? []),
    ...(agents.find(a => a.id === '*')?.rules ?? []),
  ];
  const haltOnCritical = activePolicy.environments?.[currentEnvironment]?.haltOnCritical ?? false;

  for (const rule of rules) {
    if (!matchesCondition(rule.condition, toolName, input)) continue;
    if (rule.action === 'block' && haltOnCritical && rule.severity === 'critical') {
      return { action: 'halt_agent', rule };
    }
    return { action: rule.action, rule };
  }

  return { action: activePolicy.defaultAction };
}

function matchesCondition(condition: PolicyCondition, toolName: string, input: unknown): boolean {
  if (condition.tool !== undefined) {
    const tools = Array.isArray(condition.tool) ? condition.tool : [condition.tool];
    if (!tools.includes(toolName)) return false;
  }

  for (const [key, expected] of Object.entries(condition)) {
    if (key === 'tool') continue;
    const value = getNestedValue(input, key);

    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      // Every constraint set on a key must hold. Type mismatches never match.
      if (expected.greaterThan !== undefined && !(typeof value === 'number' && value > expected.greaterThan)) return false;
      if (expected.lessThan !== undefined && !(typeof value === 'number' && value < expected.lessThan)) return false;
      if (expected.equals !== undefined && value !== expected.equals) return false;
      if (expected.notEquals !== undefined && value === expected.notEquals) return false;
      const ci = expected.ignoreCase === true;
      if (expected.contains !== undefined && !(typeof value === 'string' && (ci ? value.toLowerCase().includes(expected.contains.toLowerCase()) : value.includes(expected.contains)))) return false;
      if (expected.matches !== undefined && !(typeof value === 'string' && new RegExp(expected.matches, ci ? 'i' : '').test(value))) return false;
      if (expected.oneOf !== undefined && !expected.oneOf.includes(value as string | number | boolean | null)) return false;
    } else if (value !== expected) {
      return false;
    }
  }

  return true;
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && Object.prototype.hasOwnProperty.call(acc, key)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

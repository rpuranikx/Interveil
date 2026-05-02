export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface TraceEvent {
  event_id: string;
  session_id: string;
  step_index: number;
  step_type: string;
  input: unknown;
  output: unknown;
  timestamp: string;
  duration_ms?: number;
  token_usage?: TokenUsage;
  model?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export interface Session {
  session_id: string;
  name?: string;
  agent_id?: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  ended_at?: string;
  metadata?: Record<string, unknown>;
}

export const STEP_COLORS: Record<string, string> = {
  REASONING: '#3B82F6',
  TOOL_CALL: '#F97316',
  TOOL_RESULT: '#22C55E',
  LLM_REQUEST: '#A855F7',
  LLM_RESPONSE: '#14B8A6',
  ERROR: '#EF4444',
  CUSTOM: '#6B7280',
  COMMAND_BLOCKED: '#EF4444',
  COMMAND_DRY_RUN: '#EAB308',
  TOOL_PERMISSION_DENIED: '#EF4444',
  SIDECAR_ANOMALY: '#F97316',
  POLICY_VIOLATION: '#EF4444',
  POLICY_AUDIT: '#EAB308',
};

export const STEP_LABELS: Record<string, string> = {
  REASONING: 'Reasoning',
  TOOL_CALL: 'Tool Call',
  TOOL_RESULT: 'Tool Result',
  LLM_REQUEST: 'LLM Request',
  LLM_RESPONSE: 'LLM Response',
  ERROR: 'Error',
  CUSTOM: 'Custom',
  COMMAND_BLOCKED: 'Blocked',
  COMMAND_DRY_RUN: 'Dry Run',
  TOOL_PERMISSION_DENIED: 'Access Denied',
  SIDECAR_ANOMALY: 'Anomaly',
  POLICY_VIOLATION: 'Policy Violation',
  POLICY_AUDIT: 'Policy Audit',
};

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
  REASONING: '#8ef0c8',
  TOOL_CALL: '#f5c26b',
  TOOL_RESULT: '#8ef0c8',
  LLM_REQUEST: '#c7b8ff',
  LLM_RESPONSE: '#7fd4ff',
  ERROR: '#ff6b4a',
  CUSTOM: '#6a6c6a',
  COMMAND_BLOCKED: '#ff6b4a',
  COMMAND_DRY_RUN: '#f5c26b',
  TOOL_PERMISSION_DENIED: '#ff6b4a',
  POLICY_VIOLATION: '#ff6b4a',
  POLICY_AUDIT: '#f5c26b',
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
  POLICY_VIOLATION: 'Policy Violation',
  POLICY_AUDIT: 'Policy Audit',
};

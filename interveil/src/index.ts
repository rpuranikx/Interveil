// Phase 1 — Core
export { trace } from './sdk/trace.js';
export { InterveillClient } from './sdk/client.js';
export { startServer, createApp } from './server.js';
export type { TraceOptions } from './sdk/trace.js';
export type { ClientOptions, StartSessionOptions, EmitOptions } from './sdk/client.js';
export type { Session, TraceEvent, TraceStore, TokenUsage } from './store/memory.js';

// Phase 2 — Command Control
export { checkCommand, interceptChildProcess } from './commands/interceptor.js';
export type { CommandInterceptorOptions, BlockEvent } from './commands/interceptor.js';

// Phase 3 — Tool Registry + Access Control
export { registerTool, definePolicy, callTool, callToolSilent, checkToolAccess, exportPolicy, importPolicy, hasRegisteredTool, getRegisteredTool, ToolPermissionError } from './tools/registry.js';
export type { ToolDefinition, AgentPolicy, ToolRule, PermissionType, AccessCondition } from './tools/registry.js';

// Phase 4 — Memory (store interface, swappable)
export { MemoryStore } from './store/memory.js';

// Phase 5 — Sidecar Monitor
export { initSidecar, getSidecar, SidecarMonitor, CriticalAnomalyError } from './sidecar/monitor.js';
export type { SidecarConfig, AnomalyEvent, FailureExplanation } from './sidecar/monitor.js';

// Phase 6 — Policy as Code
export { loadPolicyFile, validatePolicyFile, evaluatePolicy, PolicyViolationError } from './policy/engine.js';
export type { PolicyFile, AgentPolicySpec, PolicyRule, PolicyEvalResult } from './policy/engine.js';

// Phase 7 — Multi-Agent Orchestration
export { getTraceContext, registerChildAgent, getAgentGraph, updateAgentStatus } from './multiagent/orchestration.js';
export type { TraceContext, AgentNode } from './multiagent/orchestration.js';

// Phase 8 — Teams
export { createUser, loginUser, validateToken, authEnabled, requireAuth } from './teams/auth.js';
export { addComment, getComments, resolveComment, getUnresolvedCount } from './teams/comments.js';

// Phase 9 — Integrations
export { InterveillCallbackHandler } from './integrations/langchain.js';
export { createTracedAnthropic } from './integrations/anthropic-sdk.js';
export { tracedRunner } from './integrations/openai-agents.js';

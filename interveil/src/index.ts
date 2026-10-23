// Server
export { startServer, createApp } from './server.js';
export type { ServerOptions, StartedServer } from './server.js';

// Tracing SDK
export { trace } from './sdk/trace.js';
export { InterveillClient } from './sdk/client.js';
export type { TraceOptions } from './sdk/trace.js';
export type { ClientOptions, StartSessionOptions, EmitOptions } from './sdk/client.js';

// Policy as code
export { loadPolicyFile, setPolicy, validatePolicyFile, evaluatePolicy, PolicyViolationError, PolicyLoadError } from './policy/engine.js';
export type { PolicyFile, AgentPolicySpec, PolicyRule, PolicyEvalResult } from './policy/engine.js';

// Command blocklist
export { checkCommand, interceptChildProcess } from './commands/interceptor.js';
export type { CommandInterceptorOptions, BlockEvent } from './commands/interceptor.js';

// Tool registry (input schema validation for tools called through trace())
export { registerTool, callTool, hasRegisteredTool, getRegisteredTool, ToolInputError } from './tools/registry.js';
export type { ToolDefinition } from './tools/registry.js';

// Storage
export { MemoryStore, setStore } from './store/memory.js';
export { SqliteStore } from './store/sqlite.js';
export type { Session, TraceEvent, TraceStore, TokenUsage } from './store/memory.js';

// Framework callbacks (tracing only)
export { InterveillCallbackHandler } from './integrations/langchain.js';
export { createTracedAnthropic } from './integrations/anthropic-sdk.js';

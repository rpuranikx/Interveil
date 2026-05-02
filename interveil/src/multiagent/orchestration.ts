import { v4 as uuidv4 } from 'uuid';
import { store } from '../store/memory.js';
import { broadcast } from '../ws/broadcaster.js';

export interface TraceContext {
  sessionId: string;
  parentSessionId?: string;
  agentId: string;
  depth: number;
  spawnedAtStepId?: string;
}

export interface AgentNode {
  session_id: string;
  parent_session_id: string | null;
  agent_id: string;
  depth: number;
  spawned_at_step_id: string | null;
  status: 'running' | 'completed' | 'failed';
}

const agentGraph: Map<string, AgentNode> = new Map();

export function getTraceContext(sessionId: string, agentId: string): TraceContext {
  return {
    sessionId,
    agentId,
    depth: agentGraph.get(sessionId)?.depth ?? 0,
  };
}

export async function registerChildAgent(
  parentContext: TraceContext,
  childAgentId: string,
  spawnedAtStepId?: string
): Promise<TraceContext> {
  const childSessionId = uuidv4();
  const childDepth = parentContext.depth + 1;

  const node: AgentNode = {
    session_id: childSessionId,
    parent_session_id: parentContext.sessionId,
    agent_id: childAgentId,
    depth: childDepth,
    spawned_at_step_id: spawnedAtStepId ?? null,
    status: 'running',
  };

  agentGraph.set(childSessionId, node);

  await store.createSession({
    session_id: childSessionId,
    name: `${childAgentId} (child of ${parentContext.agentId})`,
    agent_id: childAgentId,
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {
      parent_session_id: parentContext.sessionId,
      depth: childDepth,
      spawned_at_step_id: spawnedAtStepId,
    },
  });

  broadcast({
    type: 'agent_spawned',
    child_session_id: childSessionId,
    parent_session_id: parentContext.sessionId,
    agent_id: childAgentId,
    depth: childDepth,
    timestamp: new Date().toISOString(),
  });

  return {
    sessionId: childSessionId,
    parentSessionId: parentContext.sessionId,
    agentId: childAgentId,
    depth: childDepth,
    spawnedAtStepId,
  };
}

export function getAgentGraph(): AgentNode[] {
  return Array.from(agentGraph.values());
}

export function buildAgentTree(rootSessionId: string): AgentNode | null {
  const root = agentGraph.get(rootSessionId);
  if (!root) return null;
  return root;
}

export function updateAgentStatus(sessionId: string, status: 'completed' | 'failed'): void {
  const node = agentGraph.get(sessionId);
  if (node) {
    agentGraph.set(sessionId, { ...node, status });
    broadcast({
      type: 'agent_status_updated',
      session_id: sessionId,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

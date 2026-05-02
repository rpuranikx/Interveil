import { v4 as uuidv4 } from 'uuid';
import { TraceEvent } from '../store/memory.js';
import { broadcast } from '../ws/broadcaster.js';

export type AnomalyType = 'loop' | 'contradiction' | 'unexpected_tool' | 'permission_probe' | 'context_drift';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type InterventionLevel = 'observe' | 'warn' | 'halt';

export interface AnomalyEvent {
  step_type: 'SIDECAR_ANOMALY';
  anomaly_type: AnomalyType;
  severity: Severity;
  affected_steps: string[];
  explanation: string;
  recommendation: string;
  confidence: number;
}

export interface SidecarConfig {
  enabled: boolean;
  model?: string;
  interventionLevel?: InterventionLevel;
  systemPrompt?: string;
}

export interface FailureExplanation {
  root_cause: string;
  contributing_factors: string[];
  first_bad_step: string;
  suggested_fix: string;
}

export class SidecarMonitor {
  private readonly config: SidecarConfig;
  private readonly sessionEvents: Map<string, TraceEvent[]> = new Map();

  constructor(config: SidecarConfig) {
    this.config = config;
  }

  observe(event: TraceEvent): void {
    if (!this.config.enabled) return;

    const events = this.sessionEvents.get(event.session_id) ?? [];
    events.push(event);
    this.sessionEvents.set(event.session_id, events);

    const anomalies = this.detectAnomalies(event.session_id, events);
    for (const anomaly of anomalies) {
      this.handleAnomaly(anomaly, event.session_id, events);
    }

    if (event.step_type === 'ERROR') {
      void this.explainFailure(event.session_id, events, event);
    }
  }

  private detectAnomalies(sessionId: string, events: TraceEvent[]): AnomalyEvent[] {
    const anomalies: AnomalyEvent[] = [];

    // Loop detection: same tool called 3+ times with identical inputs
    const toolCalls = events.filter(e => e.step_type === 'TOOL_CALL');
    const toolCallMap = new Map<string, TraceEvent[]>();
    for (const call of toolCalls) {
      const key = JSON.stringify({ input: call.input });
      const existing = toolCallMap.get(key) ?? [];
      existing.push(call);
      toolCallMap.set(key, existing);
    }
    for (const [, calls] of toolCallMap) {
      if (calls.length >= 3) {
        anomalies.push({
          step_type: 'SIDECAR_ANOMALY',
          anomaly_type: 'loop',
          severity: 'high',
          affected_steps: calls.map(c => c.event_id),
          explanation: `Same tool called ${calls.length} times with identical inputs — possible infinite loop`,
          recommendation: 'Add a loop termination condition or check if tool results are being properly consumed',
          confidence: 0.9,
        });
      }
    }

    // Permission boundary probing: multiple permission violations in sequence
    const violations = events.filter(e =>
      e.step_type === 'TOOL_PERMISSION_DENIED' || e.step_type === 'COMMAND_BLOCKED'
    );
    if (violations.length >= 3) {
      const recent = violations.slice(-3);
      const timeSpan = new Date(recent[recent.length - 1].timestamp).getTime() -
        new Date(recent[0].timestamp).getTime();
      if (timeSpan < 10000) {
        anomalies.push({
          step_type: 'SIDECAR_ANOMALY',
          anomaly_type: 'permission_probe',
          severity: 'critical',
          affected_steps: recent.map(e => e.event_id),
          explanation: `${violations.length} permission violations in ${(timeSpan / 1000).toFixed(1)}s — possible permission boundary probing`,
          recommendation: 'Review agent instructions and verify there is no prompt injection targeting restricted tools',
          confidence: 0.85,
        });
      }
    }

    return anomalies;
  }

  private handleAnomaly(anomaly: AnomalyEvent, sessionId: string, events: TraceEvent[]): void {
    const event = {
      event_id: uuidv4(),
      session_id: sessionId,
      step_index: events.length,
      ...anomaly,
      input: null,
      output: anomaly,
      timestamp: new Date().toISOString(),
    };

    broadcast(event);

    const level = this.config.interventionLevel ?? 'observe';

    if (level === 'warn' || level === 'halt') {
      if (anomaly.severity === 'high' || anomaly.severity === 'critical') {
        console.warn(`\n[Interveil Sidecar] ⚠ ANOMALY DETECTED`);
        console.warn(`  Type: ${anomaly.anomaly_type}`);
        console.warn(`  Severity: ${anomaly.severity.toUpperCase()}`);
        console.warn(`  ${anomaly.explanation}`);
        console.warn(`  → ${anomaly.recommendation}\n`);
      }
    }

    if (level === 'halt' && anomaly.severity === 'critical') {
      console.error('[Interveil Sidecar] Critical anomaly detected — halting agent');
      process.exit(1);
    }
  }

  private async explainFailure(sessionId: string, events: TraceEvent[], errorEvent: TraceEvent): Promise<void> {
    const explanation: FailureExplanation = this.generateLocalExplanation(events, errorEvent);

    const event = {
      event_id: uuidv4(),
      session_id: sessionId,
      step_index: events.length,
      step_type: 'SIDECAR_ANOMALY',
      anomaly_type: 'contradiction',
      input: null,
      output: explanation,
      timestamp: new Date().toISOString(),
      metadata: { type: 'failure_explanation', ...explanation },
    };

    broadcast(event);
  }

  private generateLocalExplanation(events: TraceEvent[], errorEvent: TraceEvent): FailureExplanation {
    const error = errorEvent.error as { message?: string } | undefined;
    const precedingEvent = events.find(e => e.step_index === errorEvent.step_index - 1);

    return {
      root_cause: error?.message ?? 'Unknown error occurred',
      contributing_factors: precedingEvent
        ? [`Step ${precedingEvent.step_index} (${precedingEvent.step_type}) may have produced invalid data`]
        : ['No preceding steps to analyze'],
      first_bad_step: errorEvent.event_id,
      suggested_fix: `Review the input to step ${errorEvent.step_index} and validate the output of step ${errorEvent.step_index - 1}`,
    };
  }
}

let globalSidecar: SidecarMonitor | null = null;

export function initSidecar(config: SidecarConfig): SidecarMonitor {
  globalSidecar = new SidecarMonitor(config);
  return globalSidecar;
}

export function getSidecar(): SidecarMonitor | null {
  return globalSidecar;
}

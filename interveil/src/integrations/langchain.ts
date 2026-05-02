import { InterveillClient } from '../sdk/client.js';

export interface LangChainCallbackEvent {
  name?: string;
  inputs?: unknown;
  outputs?: unknown;
  error?: Error;
  kwargs?: Record<string, unknown>;
}

export class InterveillCallbackHandler {
  private client: InterveillClient;
  private sessionId: string | null = null;
  private stepIndex = 0;
  private sessionPromise: Promise<void> | null = null;

  constructor(options: { port?: number; host?: string; sessionName?: string } = {}) {
    this.client = new InterveillClient({ port: options.port, host: options.host });
  }

  private async ensureSession(name?: string): Promise<string> {
    if (!this.sessionId) {
      if (!this.sessionPromise) {
        this.sessionPromise = this.client.startSession({ name: name ?? 'LangChain run' }).then(s => {
          this.sessionId = s.session_id;
        });
      }
      await this.sessionPromise;
    }
    return this.sessionId!;
  }

  async handleLLMStart(serialized: unknown, prompts: string[]): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'LLM_REQUEST',
      input: { prompts, serialized },
      output: null,
      timestamp: new Date().toISOString(),
    });
  }

  async handleLLMEnd(output: unknown): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'LLM_RESPONSE',
      input: null,
      output,
      timestamp: new Date().toISOString(),
    });
  }

  async handleToolStart(tool: unknown, input: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'TOOL_CALL',
      input: { tool, input },
      output: null,
      timestamp: new Date().toISOString(),
    });
  }

  async handleToolEnd(output: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'TOOL_RESULT',
      input: null,
      output,
      timestamp: new Date().toISOString(),
    });
  }

  async handleAgentAction(action: unknown): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'REASONING',
      input: action,
      output: null,
      timestamp: new Date().toISOString(),
    });
  }

  async handleChainError(err: Error): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'ERROR',
      input: null,
      output: null,
      error: { message: err.message, stack: err.stack },
      timestamp: new Date().toISOString(),
    });
    await this.client.endSession(sid, 'failed');
  }

  async handleChainEnd(): Promise<void> {
    if (this.sessionId) {
      await this.client.endSession(this.sessionId, 'completed');
    }
  }
}

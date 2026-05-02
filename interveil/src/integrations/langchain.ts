import { InterveillClient } from '../sdk/client.js';

/**
 * InterveillCallbackHandler — drop-in LangChain callback handler.
 *
 * Usage (LangChain.js v0.2+):
 *   const handler = new InterveillCallbackHandler({ sessionName: 'my-chain' });
 *   const result = await chain.invoke(input, { callbacks: [handler] });
 *
 * The class intentionally does not import from @langchain/core so that
 * Interveil itself does not carry LangChain as a required dependency.
 * It implements the full BaseCallbackHandler interface structurally, so
 * TypeScript will accept it wherever BaseCallbackHandler is expected
 * (duck typing / structural subtyping).
 *
 * If you want strict extends-based typing, add:
 *   import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
 *   export class InterveillCallbackHandler extends BaseCallbackHandler { ... }
 */

export class InterveillCallbackHandler {
  /** Required by LangChain's BaseCallbackHandler interface */
  readonly name = 'InterveillCallbackHandler';

  private client: InterveillClient;
  private sessionId: string | null = null;
  private stepIndex = 0;
  private sessionPromise: Promise<void> | null = null;
  private readonly sessionName: string;

  constructor(options: { port?: number; host?: string; sessionName?: string } = {}) {
    this.client = new InterveillClient({ port: options.port, host: options.host });
    this.sessionName = options.sessionName ?? 'LangChain run';
  }

  private async ensureSession(name?: string): Promise<string> {
    if (!this.sessionId) {
      if (!this.sessionPromise) {
        this.sessionPromise = this.client.startSession({ name: name ?? this.sessionName }).then(s => {
          this.sessionId = s.session_id;
        });
      }
      await this.sessionPromise;
    }
    return this.sessionId!;
  }

  // ── LLM ──────────────────────────────────────────────────────────────────

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
    const usage = (output as { llmOutput?: { tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } } })
      ?.llmOutput?.tokenUsage;
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'LLM_RESPONSE',
      input: null,
      output,
      timestamp: new Date().toISOString(),
      token_usage: usage ? {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      } : undefined,
    });
  }

  async handleLLMError(err: Error): Promise<void> {
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
  }

  // ── Chain ─────────────────────────────────────────────────────────────────

  async handleChainStart(serialized: unknown, inputs: unknown): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'REASONING',
      input: { serialized, inputs },
      output: null,
      timestamp: new Date().toISOString(),
    });
  }

  async handleChainEnd(outputs: unknown): Promise<void> {
    if (this.sessionId) {
      await this.client.emit({
        session_id: this.sessionId,
        step_index: this.stepIndex++,
        step_type: 'CUSTOM',
        input: null,
        output: outputs,
        timestamp: new Date().toISOString(),
        metadata: { event: 'chain_end' },
      });
      await this.client.endSession(this.sessionId, 'completed');
    }
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

  // ── Tool ──────────────────────────────────────────────────────────────────

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

  async handleToolError(err: Error): Promise<void> {
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
  }

  // ── Agent ─────────────────────────────────────────────────────────────────

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

  async handleAgentEnd(action: unknown): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'CUSTOM',
      input: null,
      output: action,
      timestamp: new Date().toISOString(),
      metadata: { event: 'agent_end' },
    });
  }

  // ── Retriever ─────────────────────────────────────────────────────────────

  async handleRetrieverStart(serialized: unknown, query: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'TOOL_CALL',
      input: { retriever: serialized, query },
      output: null,
      timestamp: new Date().toISOString(),
      metadata: { event: 'retriever_start' },
    });
  }

  async handleRetrieverEnd(documents: unknown): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'TOOL_RESULT',
      input: null,
      output: documents,
      timestamp: new Date().toISOString(),
      metadata: { event: 'retriever_end' },
    });
  }

  async handleRetrieverError(err: Error): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'ERROR',
      input: null,
      output: null,
      error: { message: err.message, stack: err.stack },
      timestamp: new Date().toISOString(),
      metadata: { event: 'retriever_error' },
    });
  }

  // ── Text ──────────────────────────────────────────────────────────────────

  async handleText(text: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.client.emit({
      session_id: sid,
      step_index: this.stepIndex++,
      step_type: 'CUSTOM',
      input: null,
      output: text,
      timestamp: new Date().toISOString(),
      metadata: { event: 'text' },
    });
  }
}

import { InterveillClient } from '../sdk/client.js';

export interface AnthropicLike {
  messages: {
    create: (params: Record<string, unknown>) => Promise<unknown>;
  };
}

export function createTracedAnthropic<T extends AnthropicLike>(
  anthropic: T,
  options: { port?: number; host?: string; sessionName?: string } = {}
): T {
  const client = new InterveillClient({ port: options.port, host: options.host });
  let sessionId: string | null = null;
  let stepIndex = 0;

  const ensureSession = async () => {
    if (!sessionId) {
      const s = await client.startSession({ name: options.sessionName ?? 'Anthropic SDK run' });
      sessionId = s.session_id;
    }
    return sessionId!;
  };

  return new Proxy(anthropic, {
    get(target, prop) {
      if (prop === 'messages') {
        return new Proxy(target.messages, {
          get(msgTarget, msgProp) {
            if (msgProp === 'create') {
              return async (params: Record<string, unknown>) => {
                const sid = await ensureSession();
                const timestamp = new Date().toISOString();
                const start = Date.now();

                await client.emit({
                  session_id: sid,
                  step_index: stepIndex++,
                  step_type: 'LLM_REQUEST',
                  input: params,
                  output: null,
                  timestamp,
                  model: params.model as string,
                });

                try {
                  const result = await msgTarget.create(params);
                  const duration_ms = Date.now() - start;

                  const resp = result as {
                    usage?: { input_tokens?: number; output_tokens?: number };
                    stop_reason?: string;
                  };

                  await client.emit({
                    session_id: sid,
                    step_index: stepIndex++,
                    step_type: 'LLM_RESPONSE',
                    input: null,
                    output: result,
                    timestamp: new Date().toISOString(),
                    duration_ms,
                    model: params.model as string,
                    token_usage: resp.usage ? {
                      prompt_tokens: resp.usage.input_tokens ?? 0,
                      completion_tokens: resp.usage.output_tokens ?? 0,
                      total_tokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
                    } : undefined,
                  });

                  return result;
                } catch (err) {
                  await client.emit({
                    session_id: sid,
                    step_index: stepIndex++,
                    step_type: 'ERROR',
                    input: params,
                    output: null,
                    error: { message: (err as Error).message },
                    timestamp: new Date().toISOString(),
                    duration_ms: Date.now() - start,
                  });
                  throw err;
                }
              };
            }
            return (msgTarget as Record<string | symbol, unknown>)[msgProp];
          },
        });
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  }) as T;
}

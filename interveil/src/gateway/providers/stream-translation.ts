/**
 * Converts a provider's SSE stream into OpenAI chat.completion.chunk events, so
 * every provider's stream goes through the same tool-call enforcement.
 */
export interface StreamTranslator {
  /** One upstream SSE event (without the trailing blank line) → zero or more OpenAI `data: ...` events. */
  event(raw: string): string[];
  /** Called when upstream ends, for providers that do not send their own terminator. */
  end(): string[];
}

/** Parsed JSON of an SSE event's data line(s), or null. */
export function sseData(raw: string): unknown {
  const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function openAIChunk(id: string, model: string, delta: object, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}`;
}

export interface OpenAIMessage {
  role: string;
  content: string | unknown[];
}

export function translateToGemini(messages: OpenAIMessage[]): Record<string, unknown> {
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

  return { contents };
}

export function translateGeminiResponse(geminiResp: Record<string, unknown>, model: string): Record<string, unknown> {
  const candidates = geminiResp.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  const text = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usageMeta = geminiResp.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;

  return {
    id: `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: usageMeta?.promptTokenCount ?? 0,
      completion_tokens: usageMeta?.candidatesTokenCount ?? 0,
      total_tokens: (usageMeta?.promptTokenCount ?? 0) + (usageMeta?.candidatesTokenCount ?? 0),
    },
  };
}

export function geminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

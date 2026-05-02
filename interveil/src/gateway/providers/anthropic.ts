export const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export interface OpenAIMessage {
  role: string;
  content: string | unknown[];
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: unknown[];
  [key: string]: unknown;
}

export function translateToAnthropic(openAIBody: OpenAIRequest): Record<string, unknown> {
  const systemMessages = openAIBody.messages.filter(m => m.role === 'system');
  const userMessages = openAIBody.messages.filter(m => m.role !== 'system');

  return {
    model: openAIBody.model,
    max_tokens: openAIBody.max_tokens ?? 4096,
    ...(systemMessages.length > 0 ? { system: systemMessages.map(m => m.content).join('\n') } : {}),
    messages: userMessages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    ...(openAIBody.temperature !== undefined ? { temperature: openAIBody.temperature } : {}),
    ...(openAIBody.stream ? { stream: true } : {}),
    ...(openAIBody.tools ? { tools: openAIBody.tools } : {}),
  };
}

export function translateAnthropicResponse(anthropicResp: Record<string, unknown>): Record<string, unknown> {
  const content = anthropicResp.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.find(c => c.type === 'text')?.text ?? '';
  const usage = anthropicResp.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    id: anthropicResp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: anthropicResp.stop_reason ?? 'stop',
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

export function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

export function anthropicUrl(): string {
  return `${ANTHROPIC_BASE}/messages`;
}

export const OPENAI_BASE = 'https://api.openai.com/v1';

export function buildOpenAIHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

/** OPENAI_BASE_URL points the gateway at any OpenAI-compatible API (Azure, OpenRouter, Ollama, a mock). */
export function openAIUrl(path: string): string {
  return `${(process.env.OPENAI_BASE_URL || OPENAI_BASE).replace(/\/$/, '')}${path}`;
}

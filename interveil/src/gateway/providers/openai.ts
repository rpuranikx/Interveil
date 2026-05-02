export const OPENAI_BASE = 'https://api.openai.com/v1';

export function buildOpenAIHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

export function openAIUrl(path: string): string {
  return `${OPENAI_BASE}${path}`;
}

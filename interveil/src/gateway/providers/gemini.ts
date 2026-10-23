import { OpenAIRequest, contentText, parseArguments } from './anthropic.js';
import { StreamTranslator, sseData, openAIChunk } from './stream-translation.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart { text?: string; functionCall?: { name: string; args?: unknown }; functionResponse?: unknown }
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

/** Gemini accepts an OpenAPI subset of JSON Schema; drop keys it rejects. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema' || k === 'strict') continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

/** OpenAI Chat Completions request → Gemini generateContent request, including tools and tool results. */
export function translateToGemini(body: OpenAIRequest): Record<string, unknown> {
  const system = body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => contentText(m.content)).join('\n');
  const toolNames = new Map<string, string>(); // tool_call_id → function name, for tool results
  const contents: GeminiContent[] = [];

  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of body.messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      const text = contentText(m.content);
      if (text) parts.push({ text });
      for (const tc of m.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function.name);
        parts.push({ functionCall: { name: tc.function.name, args: parseArguments(tc.function.arguments) } });
      }
      push('model', parts);
    } else if (m.role === 'tool') {
      const name = toolNames.get(m.tool_call_id ?? '') ?? m.name ?? 'tool';
      push('user', [{ functionResponse: { name, response: { content: contentText(m.content) } } }]);
    } else {
      const text = contentText(m.content);
      if (text) push('user', [{ text }]);
    }
  }

  const declarations = body.tools
    ?.filter(t => t.function?.name)
    .map(t => ({
      name: t.function!.name,
      ...(t.function!.description ? { description: t.function!.description } : {}),
      ...(t.function!.parameters ? { parameters: sanitizeSchema(t.function!.parameters) } : {}),
    }));
  const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;
  const generationConfig = {
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...((body.max_completion_tokens ?? body.max_tokens) ? { maxOutputTokens: body.max_completion_tokens ?? body.max_tokens } : {}),
    ...(stop ? { stopSequences: stop } : {}),
  };

  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(declarations && declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

function finishReason(reason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT') return 'content_filter';
  return 'stop';
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function usageOf(meta: GeminiResponse['usageMetadata']) {
  const prompt = meta?.promptTokenCount ?? 0;
  const completion = meta?.candidatesTokenCount ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Gemini generateContent response → OpenAI chat.completion, including tool calls. */
export function translateGeminiResponse(resp: Record<string, unknown>, model: string): Record<string, unknown> {
  const r = resp as GeminiResponse;
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(p => p.text ?? '').join('');
  const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
    id: `call_${i}`, type: 'function', function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) },
  }));

  return {
    id: `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason(r.candidates?.[0]?.finishReason, toolCalls.length > 0),
    }],
    usage: usageOf(r.usageMetadata),
  };
}

/** Gemini SSE (`alt=sse`) events → OpenAI chat.completion.chunk events. */
export function createGeminiStreamTranslator(model: string): StreamTranslator {
  const id = `gemini-${Date.now()}`;
  let started = false;
  let toolCount = 0;
  let finish: string | null = null;
  let usage = usageOf(undefined);

  return {
    event(raw) {
      const data = sseData(raw) as GeminiResponse | null;
      if (!data) return [];
      const out: string[] = [];
      if (!started) {
        started = true;
        out.push(openAIChunk(id, model, { role: 'assistant', content: '' }));
      }
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) out.push(openAIChunk(id, model, { content: part.text }));
        if (part.functionCall) {
          // Gemini sends each function call whole, so name and arguments go in one delta.
          out.push(openAIChunk(id, model, { tool_calls: [{ index: toolCount, id: `call_${toolCount}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }] }));
          toolCount++;
        }
      }
      const reason = data.candidates?.[0]?.finishReason;
      if (reason) finish = finishReason(reason, toolCount > 0);
      if (data.usageMetadata) usage = usageOf(data.usageMetadata);
      return out;
    },
    end() {
      if (!started) return [];
      return [
        openAIChunk(id, model, {}, finish ?? (toolCount > 0 ? 'tool_calls' : 'stop')),
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage })}`,
        'data: [DONE]',
      ];
    },
  };
}

export function geminiUrl(model: string, stream = false): string {
  const base = (process.env.GEMINI_BASE_URL || GEMINI_BASE).replace(/\/$/, '');
  return stream ? `${base}/models/${model}:streamGenerateContent?alt=sse` : `${base}/models/${model}:generateContent`;
}

/** The key goes in a header, so it never appears in URLs or access logs. */
export function buildGeminiHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
}

import { StreamTranslator, sseData, openAIChunk } from './stream-translation.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export interface OpenAIToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: string;
  content: string | unknown[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type?: string;
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

type AnthropicBlock = Record<string, unknown>;
interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

export function parseArguments(raw: string | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Text of an OpenAI message content (string, or text parts of a parts array). */
export function contentText(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(p => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? (p as { text?: string }).text ?? '' : ''))
    .join('');
}

function userBlocks(content: OpenAIMessage['content']): AnthropicBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicBlock[] = [];
  for (const part of content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>) {
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const data = /^data:([^;]+);base64,(.*)$/.exec(url);
      blocks.push(data
        ? { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
        : { type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

function toolChoice(choice: unknown): Record<string, unknown> | undefined {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  const named = choice as { function?: { name?: string } } | undefined;
  if (named?.function?.name) return { type: 'tool', name: named.function.name };
  return undefined;
}

/** OpenAI Chat Completions request → Anthropic Messages request, including tools and tool results. */
export function translateToAnthropic(body: OpenAIRequest): Record<string, unknown> {
  const system = body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => contentText(m.content)).join('\n');
  const messages: AnthropicMessage[] = [];

  // Anthropic requires alternating roles, so consecutive messages of one role
  // (e.g. several tool results) are merged into a single message.
  const push = (role: AnthropicMessage['role'], blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of body.messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentText(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      const text = contentText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArguments(tc.function.arguments) });
      }
      push('assistant', blocks);
    } else {
      push('user', userBlocks(m.content));
    }
  }

  const tools = body.tools
    ?.filter(t => t.function?.name)
    .map(t => ({
      name: t.function!.name,
      ...(t.function!.description ? { description: t.function!.description } : {}),
      input_schema: t.function!.parameters ?? { type: 'object', properties: {} },
    }));
  const choice = toolChoice(body.tool_choice);
  const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;

  return {
    model: body.model,
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096,
    ...(system ? { system } : {}),
    messages,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(stop ? { stop_sequences: stop } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(tools && tools.length > 0 && choice ? { tool_choice: choice } : {}),
    ...(body.stream ? { stream: true } : {}),
  };
}

export function finishReason(stopReason: unknown): string {
  switch (stopReason) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

/** Anthropic Messages response → OpenAI chat.completion, including tool calls. */
export function translateAnthropicResponse(resp: Record<string, unknown>): Record<string, unknown> {
  const content = (resp.content ?? []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
  const toolCalls = content.filter(c => c.type === 'tool_use').map(c => ({
    id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
  }));
  const usage = resp.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    id: resp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason(resp.stop_reason),
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

/** Anthropic SSE events → OpenAI chat.completion.chunk events. */
export function createAnthropicStreamTranslator(): StreamTranslator {
  let id = '';
  let model = '';
  let inputTokens = 0;
  // Anthropic block index → OpenAI tool_calls index
  const toolIndex = new Map<number, number>();

  const chunk = (delta: object, finish: string | null = null) => openAIChunk(id, model, delta, finish);

  return {
    event(raw) {
      const data = sseData(raw) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!data) return [];
      switch (data.type) {
        case 'message_start':
          id = data.message?.id ?? '';
          model = data.message?.model ?? '';
          inputTokens = data.message?.usage?.input_tokens ?? 0;
          return [chunk({ role: 'assistant', content: '' })];
        case 'content_block_start':
          if (data.content_block?.type === 'tool_use') {
            const i = toolIndex.size;
            toolIndex.set(data.index, i);
            return [chunk({ tool_calls: [{ index: i, id: data.content_block.id, type: 'function', function: { name: data.content_block.name, arguments: '' } }] })];
          }
          return [];
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta') return [chunk({ content: data.delta.text })];
          if (data.delta?.type === 'input_json_delta' && toolIndex.has(data.index)) {
            return [chunk({ tool_calls: [{ index: toolIndex.get(data.index), function: { arguments: data.delta.partial_json } }] })];
          }
          return [];
        case 'message_delta': {
          const outputTokens = data.usage?.output_tokens ?? 0;
          return [
            chunk({}, finishReason(data.delta?.stop_reason)),
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}`,
          ];
        }
        case 'message_stop':
          return ['data: [DONE]'];
        case 'error':
          return [`data: ${JSON.stringify({ error: data.error })}`];
        default:
          return []; // ping, content_block_stop
      }
    },
    end: () => [],
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
  return `${(process.env.ANTHROPIC_BASE_URL || ANTHROPIC_BASE).replace(/\/$/, '')}/messages`;
}

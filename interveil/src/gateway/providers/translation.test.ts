import { describe, it, expect } from 'vitest';
import { translateToAnthropic, translateAnthropicResponse, createAnthropicStreamTranslator, OpenAIRequest } from './anthropic.js';
import { translateToGemini, translateGeminiResponse, createGeminiStreamTranslator } from './gemini.js';
import { StreamTranslator } from './stream-translation.js';

// A conversation with a system prompt, a tool, a tool call and its result.
const conversation: OpenAIRequest = {
  model: 'm',
  temperature: 0.2,
  max_tokens: 500,
  tool_choice: 'required',
  tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false } } }],
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Weather in Paris and Rome?' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_a', content: '18C' },
    { role: 'tool', tool_call_id: 'call_b', content: '24C' },
  ],
};

/** Runs raw provider SSE events through a translator and returns the OpenAI chunk objects. */
function translateStream(t: StreamTranslator, events: object[]): any[] {
  const out = [...events.flatMap(e => t.event(`data: ${JSON.stringify(e)}`)), ...t.end()];
  return out.filter(e => e !== 'data: [DONE]').map(e => JSON.parse(e.slice(6)));
}
const streamedText = (chunks: any[]) => chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
const streamedArgs = (chunks: any[], index: number) => chunks
  .flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []).filter((t: any) => t.index === index)
  .map((t: any) => t.function?.arguments ?? '').join('');

describe('Anthropic translation', () => {
  it('translates system, tools, tool_choice, tool calls and merged tool results', () => {
    const r = translateToAnthropic(conversation) as any;
    expect(r.system).toBe('Be brief.');
    expect(r.max_tokens).toBe(500);
    expect(r.tools).toEqual([{ name: 'get_weather', description: 'Weather for a city', input_schema: conversation.tools![0].function!.parameters }]);
    expect(r.tool_choice).toEqual({ type: 'any' });
    expect(r.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(r.messages[1].content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'call_b', name: 'get_weather', input: { city: 'Rome' } },
    ]);
    // Both tool results land in one user message, as Anthropic requires.
    expect(r.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_a', content: '18C' },
      { type: 'tool_result', tool_use_id: 'call_b', content: '24C' },
    ]);
  });

  it('translates image parts', () => {
    const r = translateToAnthropic({ model: 'm', messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] }] }) as any;
    expect(r.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });

  it('translates a tool_use response into OpenAI tool_calls', () => {
    const r = translateAnthropicResponse({
      id: 'msg_1', model: 'claude-sonnet-4-5', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }) as any;
    expect(r.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { content: 'Checking.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    });
    expect(r.usage.total_tokens).toBe(30);
  });

  it('translates a streamed tool call, including split JSON arguments', () => {
    const chunks = translateStream(createAnthropicStreamTranslator(), [
      { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 7 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]);
    expect(streamedText(chunks)).toBe('Let me check.');
    expect(chunks.find(c => c.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'toolu_1', function: { name: 'get_weather' } });
    expect(streamedArgs(chunks, 0)).toBe('{"city":"Paris"}');
    expect(chunks.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.find(c => c.usage)?.usage).toEqual({ prompt_tokens: 7, completion_tokens: 12, total_tokens: 19 });
  });
});

describe('Gemini translation', () => {
  it('translates system instruction, tools, function calls and function responses', () => {
    const r = translateToGemini(conversation) as any;
    expect(r.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(r.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 500 });
    // additionalProperties is stripped; Gemini rejects it.
    expect(r.tools[0].functionDeclarations[0].parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
    expect(r.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(r.contents[1].parts).toEqual([
      { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
      { functionCall: { name: 'get_weather', args: { city: 'Rome' } } },
    ]);
    expect(r.contents[2].parts[1]).toEqual({ functionResponse: { name: 'get_weather', response: { content: '24C' } } });
  });

  it('translates a function call response into OpenAI tool_calls', () => {
    const r = translateGeminiResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Rome' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15 },
    }, 'gemini-2.5-flash') as any;
    expect(r.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] },
    });
    expect(r.usage.total_tokens).toBe(20);
  });

  it('translates a streamed response with text and a function call', () => {
    const chunks = translateStream(createGeminiStreamTranslator('gemini-2.5-flash'), [
      { candidates: [{ content: { parts: [{ text: 'Looking ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'it up.' }, { functionCall: { name: 'get_weather', args: { city: 'Rome' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } },
    ]);
    expect(streamedText(chunks)).toBe('Looking it up.');
    expect(streamedArgs(chunks, 0)).toBe('{"city":"Rome"}');
    expect(chunks.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.find(c => c.usage)?.usage.total_tokens).toBe(7);
  });
});

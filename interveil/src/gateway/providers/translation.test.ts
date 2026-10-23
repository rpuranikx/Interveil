import { describe, it, expect } from 'vitest';
import { translateToAnthropic, translateAnthropicResponse } from './anthropic.js';
import { translateToGemini, translateGeminiResponse } from './gemini.js';

describe('LLM Gateway Translation', () => {
  describe('Anthropic', () => {
    it('translates OpenAI request to Anthropic', () => {
      const openAiRequest = {
        model: 'claude-3-opus',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' }
        ],
        temperature: 0.7
      };
      const result = translateToAnthropic(openAiRequest) as any;
      
      expect(result.model).toBe('claude-3-opus');
      expect(result.system).toBe('You are a helpful assistant.');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.temperature).toBe(0.7);
    });

    it('translates Anthropic response to OpenAI format', () => {
      const anthropicResp = {
        id: 'msg_123',
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'Hi there!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 }
      };
      
      const result = translateAnthropicResponse(anthropicResp) as any;
      expect(result.id).toBe('msg_123');
      expect(result.choices[0].message.content).toBe('Hi there!');
      expect(result.usage.total_tokens).toBe(30);
    });
  });

  describe('Gemini', () => {
    it('translates OpenAI request to Gemini', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' }
        ];
        const result = translateToGemini(messages) as any;
        expect(result.contents[0].role).toBe('user');
        expect(result.contents[0].parts[0].text).toBe('Hello');
        expect(result.contents[1].role).toBe('model');
    });

    it('translates Gemini response to OpenAI format', () => {
        const geminiResp = {
            candidates: [{
                content: { parts: [{ text: 'Response' }] }
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15 }
        };
        const result = translateGeminiResponse(geminiResp, 'gemini-1.5-pro') as any;
        expect(result.model).toBe('gemini-1.5-pro');
        expect(result.choices[0].message.content).toBe('Response');
        expect(result.usage.total_tokens).toBe(20);
    });
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { openAIUrl } from './openai.js';
import { anthropicUrl } from './anthropic.js';
import { geminiUrl } from './gemini.js';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe('upstream base URLs', () => {
  it('default to the public provider APIs', () => {
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.GEMINI_BASE_URL;
    expect(openAIUrl('/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(anthropicUrl()).toBe('https://api.anthropic.com/v1/messages');
    expect(geminiUrl('gemini-2.0-flash', 'k')).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=k');
  });

  it('follow the *_BASE_URL environment variables, with or without a trailing slash', () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1/';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9000/v1';
    process.env.GEMINI_BASE_URL = 'http://127.0.0.1:9001/v1beta';
    expect(openAIUrl('/chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
    expect(anthropicUrl()).toBe('http://127.0.0.1:9000/v1/messages');
    expect(geminiUrl('m', 'k')).toBe('http://127.0.0.1:9001/v1beta/models/m:generateContent?key=k');
  });
});

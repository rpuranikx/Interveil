import { describe, it, expect, afterAll } from 'vitest';
import { runDemo, DemoResult } from './scenario.js';
import { store } from '../store/memory.js';

let demo: DemoResult;
const saved = process.env.OPENAI_BASE_URL;
afterAll(() => {
  demo?.close();
  process.env.OPENAI_BASE_URL = saved;
});

describe('interveil demo', () => {
  it('lets the legitimate refund through and blocks the injected tool calls', async () => {
    demo = await runDemo({ port: 0, stepDelayMs: 0, log: () => {} });

    expect(demo.executed).toEqual(['lookup_order', 'issue_refund']);
    expect(demo.finalMessage).toContain('large-refunds');
    expect(demo.finalMessage).toContain('pipe-to-shell');

    const events = await store.getEvents(demo.sessionId);
    const decisions = events
      .filter(e => e.step_type.startsWith('POLICY_'))
      .map(e => `${e.step_type}:${e.metadata?.rule_id}`);
    expect(decisions).toEqual([
      'POLICY_AUDIT:audit-refunds',
      'POLICY_VIOLATION:large-refunds',
      'POLICY_VIOLATION:pipe-to-shell',
    ]);
  });
});

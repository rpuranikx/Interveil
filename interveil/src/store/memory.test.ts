import { describe, it, expect } from 'vitest';
import { MemoryStore, TraceEvent } from './memory.js';

const event = (session: string, i: number): TraceEvent => ({
  event_id: `${session}-${i}`, session_id: session, step_index: i, step_type: 'CUSTOM',
  input: null, output: null, timestamp: new Date().toISOString(),
});

async function fill(store: MemoryStore, session: string, n: number) {
  await store.createSession({ session_id: session, status: 'running', started_at: new Date().toISOString() });
  for (let i = 0; i < n; i++) await store.addEvent(event(session, i));
}

describe('MemoryStore', () => {
  it('drops the oldest whole sessions when it exceeds maxEvents', async () => {
    const store = new MemoryStore(10);
    await fill(store, 'old', 4);
    await fill(store, 'mid', 4);
    await fill(store, 'new', 4); // 12 events > 10: "old" goes
    expect(await store.getSession('old')).toBeNull();
    expect((await store.getEvents('mid')).length).toBe(4);
    expect((await store.getEvents('new')).length).toBe(4);
  });

  it('never evicts the session being written to', async () => {
    const store = new MemoryStore(3);
    await fill(store, 'only', 5);
    expect((await store.getEvents('only')).length).toBe(5);
  });

  it('returns a copy of the events, sorted by step', async () => {
    const store = new MemoryStore();
    await store.createSession({ session_id: 's', status: 'running', started_at: '' });
    await store.addEvent(event('s', 1));
    await store.addEvent(event('s', 0));
    const events = await store.getEvents('s');
    expect(events.map(e => e.step_index)).toEqual([0, 1]);
    events.pop();
    expect((await store.getEvents('s')).length).toBe(2);
    expect(await store.nextStepIndex('s')).toBe(2);
  });
});

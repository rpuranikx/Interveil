import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteStore } from './sqlite.js';

describe('SqliteStore', () => {
  it('round-trips sessions and events and keeps them across reopen', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'interveil-sqlite-')), 'traces.db');
    const first = new SqliteStore(file);
    await first.createSession({ session_id: 's1', name: 'run', status: 'running', started_at: '2026-01-01T00:00:00.000Z', metadata: { source: 'test' } });
    await first.addEvent({ event_id: 'e2', session_id: 's1', step_index: 1, step_type: 'LLM_RESPONSE', input: null, output: { text: 'hi' }, timestamp: '2026-01-01T00:00:01.000Z', token_usage: { total_tokens: 3 } });
    await first.addEvent({ event_id: 'e1', session_id: 's1', step_index: 0, step_type: 'LLM_REQUEST', input: { q: 1 }, output: null, timestamp: '2026-01-01T00:00:00.500Z' });
    await first.updateSession('s1', { status: 'completed', ended_at: '2026-01-01T00:00:02.000Z' });

    const reopened = new SqliteStore(file);
    expect(await reopened.getSession('s1')).toMatchObject({ name: 'run', status: 'completed', metadata: { source: 'test' } });
    const events = await reopened.getEvents('s1');
    expect(events.map(e => e.event_id)).toEqual(['e1', 'e2']);
    expect(events[1]).toMatchObject({ output: { text: 'hi' }, token_usage: { total_tokens: 3 } });
    expect((await reopened.getAllSessions()).map(s => s.session_id)).toEqual(['s1']);
    expect(await reopened.nextStepIndex('s1')).toBe(2);
    expect(await reopened.nextStepIndex('unknown')).toBe(0);
  });

  // chmod only toggles the read-only bit on Windows; profile ACLs apply there.
  it.skipIf(process.platform === 'win32')('keeps the database and its WAL files owner-only', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'interveil-sqlite-')), 'traces.db');
    const old = process.umask(0o022);
    try {
      const store = new SqliteStore(file);
      await store.createSession({ session_id: 's1', status: 'running', started_at: '2026-01-01T00:00:00.000Z' });
      for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(statSync(f).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startServer } from '../server.js';
import { setPolicy } from '../policy/engine.js';
import { resetHalts, haltedBy } from '../gateway/enforcement.js';

const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'interveil-halts-')), 'traces.db');
const servers: http.Server[] = [];
afterAll(() => servers.forEach(s => s.close()));

async function boot() {
  const started = await startServer({ port: 0, dbPath });
  servers.push(started.server);
  return `http://127.0.0.1:${started.port}`;
}
const json = (r: Response) => r.json() as Promise<any>;
const post = (base: string, body: object) => fetch(`${base}/api/v1/policy/evaluate`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(json);

describe('halts', () => {
  it('survive a restart and stay until lifted', async () => {
    setPolicy({ version: '1', agents: [{ id: '*', rules: [{ id: 'kill-switch', action: 'halt_agent', condition: { tool: 'drop_database' } }] }] });
    const first = await boot();
    await post(first, { agent_id: 'ops', tool: 'drop_database' });
    expect((await fetch(`${first}/api/v1/policy/halts`).then(json)).halts).toMatchObject([{ agent_id: 'ops', rule_id: 'kill-switch' }]);

    // Simulate a restart: in-process state is gone, the SQLite file remains.
    resetHalts();
    expect(haltedBy('ops')).toBeUndefined();
    const second = await boot();
    expect((await post(second, { agent_id: 'ops', tool: 'read_file' })).allowed).toBe(false);

    expect((await fetch(`${second}/api/v1/policy/halts/ops`, { method: 'DELETE' })).status).toBe(200);
    expect((await post(second, { agent_id: 'ops', tool: 'read_file' })).allowed).toBe(true);
    expect((await fetch(`${second}/api/v1/policy/halts/ops`, { method: 'DELETE' })).status).toBe(404);
  });
});

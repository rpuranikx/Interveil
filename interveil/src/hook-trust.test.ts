import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { startServer } from './server.js';
import { clearPolicy, loadPolicyFile, setPolicy } from './policy/engine.js';
import { policyFileHash, verifyServer, initClaudeCode, pinnedPolicyHashes } from './claude-code.js';

// The Claude Code hook must only trust the server it was set up for: one that holds the
// API key and runs the pinned policy. Otherwise an agent can start a second server with
// no policy (it reads the same key file), kill the real one, and carry on unchecked.

const preset = path.join(__dirname, '..', 'examples', 'policies', 'coding-agent.yaml');
const key = randomBytes(32).toString('hex');
let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; clearPolicy(); });

async function ask(apiKey: string | undefined, sendKey = key) {
  const started = await startServer({ port: 0, apiKey });
  server = started.server;
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(`http://127.0.0.1:${started.port}/api/v1/policy/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-interveil-nonce': nonce, 'x-interveil-key': sendKey },
    body: JSON.stringify({ tool: 'Bash', arguments: { command: 'git push --force' }, agent_id: 'claude-code' }),
  });
  const body = await res.text();
  return { nonce, body, proof: res.headers.get('x-interveil-proof'), reported: (JSON.parse(body) as { policy_sha256: string | null }).policy_sha256 };
}

describe('hook trust in the server', () => {
  it('trusts the real server: right key, pinned policy', async () => {
    loadPolicyFile(preset);
    const r = await ask(key);
    expect(r.reported).toBe(policyFileHash(preset));
    expect(verifyServer({ key, nonce: r.nonce, body: r.body, proof: r.proof, expectedPolicy: policyFileHash(preset), reportedPolicy: r.reported })).toBeNull();
  });

  it('refuses a server started with the same key but no policy (the swap)', async () => {
    const r = await ask(key);
    expect(r.reported).toBeNull();
    expect(verifyServer({ key, nonce: r.nonce, body: r.body, proof: r.proof, expectedPolicy: policyFileHash(preset), reportedPolicy: r.reported }))
      .toMatch(/running policy none/);
  });

  it('refuses a server running a different policy', async () => {
    setPolicy({ version: '1', agents: [] });
    const r = await ask(key);
    expect(verifyServer({ key, nonce: r.nonce, body: r.body, proof: r.proof, expectedPolicy: policyFileHash(preset), reportedPolicy: r.reported }))
      .toMatch(/this hook was set up for policy/);
  });

  it('refuses an answer not signed with the key: no key on the server, or a stand-in', async () => {
    loadPolicyFile(preset);
    const r = await ask(undefined);
    expect(r.proof).toBeNull();
    expect(verifyServer({ key, nonce: r.nonce, body: r.body, proof: r.proof, expectedPolicy: policyFileHash(preset), reportedPolicy: r.reported }))
      .toMatch(/did not prove it holds/);
    // A forged "allowed" body that reuses a real proof fails too: the proof covers the body.
    const real = await (server!.close(), ask(key));
    const forged = real.body.replace('"allowed":false', '"allowed":true');
    expect(verifyServer({ key, nonce: real.nonce, body: forged, proof: real.proof })).toMatch(/did not prove/);
    // And a proof for one nonce doesn't answer another.
    expect(verifyServer({ key, nonce: 'other', body: real.body, proof: real.proof })).toMatch(/did not prove/);
  });

  it('init pins the policy in the hook args, and serve can read the pin back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interveil-pin-'));
    const prev = process.env.INTERVEIL_API_KEY_FILE;
    process.env.INTERVEIL_API_KEY_FILE = path.join(dir, 'api-key');
    try {
      const settingsFile = path.join(dir, 'settings.json');
      const hash = policyFileHash(preset);
      const { entry } = initClaudeCode({ settingsFile, hookScript: '/h/.interveil/hooks/claude-code.js', url: 'http://127.0.0.1:3000', agentId: 'claude-code', key: true, policyHash: hash });
      expect(entry.args).toEqual(['/h/.interveil/hooks/claude-code.js', '--policy', hash]);
      expect(pinnedPolicyHashes([settingsFile, path.join(dir, 'missing.json')])).toEqual([{ settingsFile, hash }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.INTERVEIL_API_KEY_FILE; else process.env.INTERVEIL_API_KEY_FILE = prev;
    }
  });
});

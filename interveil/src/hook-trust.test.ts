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

describe('init turns on the sandbox', () => {
  let dir: string;
  const prev = process.env.INTERVEIL_API_KEY_FILE;
  const setup = (existing?: object) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interveil-sbx-'));
    process.env.INTERVEIL_API_KEY_FILE = path.join(dir, 'home', '.interveil', 'api-key');
    const settingsFile = path.join(dir, 'proj', '.claude', 'settings.json');
    if (existing) { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(existing)); }
    return settingsFile;
  };
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.INTERVEIL_API_KEY_FILE; else process.env.INTERVEIL_API_KEY_FILE = prev;
  });
  const run = (settingsFile: string, extra: object = {}) => initClaudeCode({
    settingsFile, hookScript: path.join(dir, 'home', '.interveil', 'hooks', 'claude-code.js'), url: 'http://127.0.0.1:3000', agentId: 'claude-code', key: true, ...extra,
  });
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

  it('denies the shell tools reads and writes of ~/.interveil and writes to the settings, keeping what was there', () => {
    const settingsFile = setup({ sandbox: { filesystem: { denyRead: ['~/.aws'], allowWrite: ['/tmp/build'] }, network: { allowedDomains: ['github.com'] } } });
    const result = run(settingsFile, { platform: 'linux' });
    expect(result).toMatchObject({ sandbox: 'on', warnings: [] });
    const sbx = read(settingsFile).sandbox;
    const home = path.join(dir, 'home', '.interveil');
    expect(sbx).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ['github.com'] } });
    expect(sbx.filesystem.denyRead).toEqual(['~/.aws', home]);
    expect(sbx.filesystem.allowWrite).toEqual(['/tmp/build']);
    expect(sbx.filesystem.denyWrite).toEqual(expect.arrayContaining([home, settingsFile, path.join(path.dirname(settingsFile), 'settings.local.json')]));
    // Running init again doesn't duplicate entries.
    run(settingsFile, { platform: 'linux' });
    expect(read(settingsFile).sandbox.filesystem.denyRead).toEqual(['~/.aws', home]);
  });

  it('points out settings that weaken it', () => {
    const settingsFile = setup({ sandbox: { excludedCommands: ['docker'], network: { allowLocalBinding: true } } });
    expect(run(settingsFile, { platform: 'darwin' }).warnings).toEqual([
      expect.stringContaining('excludedCommands (docker)'),
      expect.stringContaining('allowLocalBinding'),
    ]);
  });

  it('leaves it alone on native Windows, where it does not run, and with --no-sandbox', () => {
    const win = setup();
    expect(run(win, { platform: 'win32' }).sandbox).toBe('unsupported');
    expect(read(win).sandbox).toBeUndefined();
    expect(run(win, { platform: 'linux', sandbox: false }).sandbox).toBe('off');
    expect(read(win).sandbox).toBeUndefined();
  });
});

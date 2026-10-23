import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { trace, PolicyViolationError } from './trace.js';
import { InterveillClient, EmitOptions } from './client.js';
import { PolicyLoadError } from '../policy/engine.js';

// Capture emitted events instead of sending them to a server.
const emitted: EmitOptions[] = [];
vi.spyOn(InterveillClient.prototype, 'startSession').mockResolvedValue({ session_id: '00000000-0000-4000-8000-000000000000' });
vi.spyOn(InterveillClient.prototype, 'endSession').mockResolvedValue();
vi.spyOn(InterveillClient.prototype, 'emit').mockImplementation(async (e) => { emitted.push(e); return 'id'; });

const dir = mkdtempSync(path.join(tmpdir(), 'interveil-trace-'));
const policy = path.join(dir, 'policy.yaml');
writeFileSync(policy, `
version: "1.0"
agents:
  - id: ops-agent
    rules:
      - id: no-prod-deploy
        action: block
        message: Deploys to prod need a human
        condition: { tool: deploy, args.0: prod }
      - id: audit-reads
        action: allow_and_audit
        condition: { tool: readFile }
      - id: kill-switch
        action: halt_agent
        severity: critical
        condition: { tool: dropDatabase }
`);

function makeAgent() {
  const calls: string[] = [];
  const agent = {
    deploy: async (env: string) => { calls.push(`deploy:${env}`); return 'ok'; },
    readFile: async (p: string) => { calls.push(`read:${p}`); return 'contents'; },
    dropDatabase: async () => { calls.push('drop'); },
  };
  return { calls, agent: trace(agent, { agentId: 'ops-agent', policyFile: policy, autoOpen: false }) };
}

beforeEach(() => { emitted.length = 0; });

describe('trace() policy enforcement', () => {
  it('blocks a matching call before it executes', async () => {
    const { agent, calls } = makeAgent();
    await expect(agent.deploy('prod')).rejects.toThrow(PolicyViolationError);
    expect(calls).toEqual([]);
    expect(emitted.map(e => e.step_type)).toEqual(['POLICY_VIOLATION']);
    expect(emitted[0].metadata?.rule_id).toBe('no-prod-deploy');

    await expect(agent.deploy('staging')).resolves.toBe('ok');
    expect(calls).toEqual(['deploy:staging']);
  });

  it('records an audit event and still runs allow_and_audit calls', async () => {
    const { agent, calls } = makeAgent();
    await agent.readFile('/etc/hosts');
    expect(calls).toEqual(['read:/etc/hosts']);
    expect(emitted.map(e => e.step_type)).toContain('POLICY_AUDIT');
  });

  it('halts the agent: the matching call and every later call are refused', async () => {
    const { agent, calls } = makeAgent();
    await expect(agent.dropDatabase()).rejects.toThrow(/halted/);
    await expect(agent.readFile('/tmp/x')).rejects.toThrow(/was halted/);
    expect(calls).toEqual([]);
  });

  it('refuses to wrap an agent when the policy file is invalid', () => {
    const bad = path.join(dir, 'bad.yaml');
    writeFileSync(bad, 'version: "1.0"\nagents:\n  - id: a\n    rules:\n      - { id: r, action: deny, condition: {} }\n');
    expect(() => trace({}, { policyFile: bad, autoOpen: false })).toThrow(PolicyLoadError);
  });
});

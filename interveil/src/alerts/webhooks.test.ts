import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { notifyPolicyEvent, signature } from './webhooks.js';
import { setPolicy, PolicyLoadError } from '../policy/engine.js';
import { startServer } from '../server.js';

interface Received { headers: http.IncomingHttpHeaders; body: string }
const received: Received[] = [];
let failNext = 0;

const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    if (failNext > 0) {
      failNext--;
      res.writeHead(503).end();
    } else {
      res.writeHead(200).end();
    }
  });
});

let hookUrl = '';
const servers: http.Server[] = [receiver];

beforeAll(async () => {
  await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  process.env.TEST_WEBHOOK_SECRET = 's3cret';
});
afterAll(() => {
  servers.forEach(s => s.close());
  delete process.env.TEST_WEBHOOK_SECRET;
});

beforeEach(() => {
  received.length = 0;
  failNext = 0;
  setPolicy({ version: '1', alerts: { webhooks: [{ url: hookUrl, secretEnv: 'TEST_WEBHOOK_SECRET' }] } });
});

const violation = {
  session_id: 'sess-1',
  step_type: 'POLICY_VIOLATION',
  input: { tool_name: 'issue_refund', arguments: { amount: 4900 } },
  metadata: { rule_id: 'large-refunds', agent_id: 'support-agent', source: 'policy', message: 'Refunds over $100 need a human', enforced_at: 'gateway' },
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('policy webhooks', () => {
  it('posts a signed alert for a violation', async () => {
    await notifyPolicyEvent(violation);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(JSON.parse(body)).toMatchObject({
      type: 'policy.violation', session_id: 'sess-1', agent_id: 'support-agent', tool: 'issue_refund',
      rule_id: 'large-refunds', source: 'policy', enforced_at: 'gateway',
    });
    expect(headers['x-interveil-signature']).toBe(signature('s3cret', String(headers['x-interveil-timestamp']), body));
  });

  it('sends audit events only to hooks that ask for them', async () => {
    await notifyPolicyEvent({ ...violation, step_type: 'POLICY_AUDIT' });
    expect(received).toHaveLength(0);
    setPolicy({ version: '1', alerts: { webhooks: [{ url: hookUrl, events: ['POLICY_AUDIT'] }] } });
    await notifyPolicyEvent({ ...violation, step_type: 'POLICY_AUDIT' });
    expect(JSON.parse(received[0].body).type).toBe('policy.audit');
    expect(received[0].headers['x-interveil-signature']).toBeUndefined();
  });

  it('retries once after a 5xx', async () => {
    failNext = 1;
    await notifyPolicyEvent(violation);
    expect(received).toHaveLength(2);
  });

  it('gives up quietly when the endpoint is unreachable', async () => {
    setPolicy({ version: '1', alerts: { webhooks: [{ url: 'http://127.0.0.1:1/hook' }] } });
    await expect(notifyPolicyEvent(violation)).resolves.toBeUndefined();
  });

  it('rejects an invalid webhook URL when the policy loads', () => {
    expect(() => setPolicy({ version: '1', alerts: { webhooks: [{ url: 'not a url' }] } })).toThrow(PolicyLoadError);
  });

  it('fires for violations reported by the SDKs through the events API', async () => {
    const { port, server } = await startServer({ port: 0 });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: randomUUID(), step_index: 0, step_type: 'POLICY_VIOLATION',
        input: { method: 'deploy', args: ['prod'] }, output: null, timestamp: new Date().toISOString(),
        metadata: { rule_id: 'no-prod-deploy', agent_id: 'ops-agent' },
      }),
    });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(JSON.parse(received[0].body)).toMatchObject({ rule_id: 'no-prod-deploy', tool: 'deploy', enforced_at: 'sdk' });
  });
});

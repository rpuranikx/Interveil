import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  evaluatePolicy, loadPolicyFile, setPolicy, validatePolicyFile, PolicyLoadError,
} from './engine.js';

const dir = mkdtempSync(path.join(tmpdir(), 'interveil-policy-'));
function policyFile(name: string, yaml: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, yaml);
  return file;
}

const basePolicy = {
  version: '1.0',
  agents: [
    {
      id: 'billing-agent',
      rules: [
        { id: 'big-refund', action: 'block', condition: { tool: 'refund', 'args.0.amount': { greaterThan: 100 } } },
        { id: 'audit-refund', action: 'allow_and_audit', condition: { tool: 'refund' } },
      ],
    },
    {
      id: '*',
      rules: [{ id: 'no-drops', action: 'halt_agent', severity: 'critical', condition: { tool: 'dropDatabase' } }],
    },
  ],
};

beforeEach(() => {
  setPolicy(basePolicy);
});

describe('evaluatePolicy', () => {
  it('applies input conditions on nested argument paths', async () => {
    expect((await evaluatePolicy('billing-agent', 'refund', { args: [{ amount: 500 }] })).action).toBe('block');
    expect((await evaluatePolicy('billing-agent', 'refund', { args: [{ amount: 20 }] })).action).toBe('allow_and_audit');
  });

  it('does not coerce strings in numeric comparisons', async () => {
    const r = await evaluatePolicy('billing-agent', 'refund', { args: [{ amount: '500' }] });
    expect(r.rule?.id).toBe('audit-refund');
  });

  it('applies * rules to every agent, after agent-specific rules', async () => {
    expect((await evaluatePolicy('billing-agent', 'dropDatabase', {})).action).toBe('halt_agent');
    expect((await evaluatePolicy('some-other-agent', 'dropDatabase', {})).action).toBe('halt_agent');
  });

  it('uses defaultAction when nothing matches', async () => {
    expect((await evaluatePolicy('unknown', 'search', {})).action).toBe('allow');
    setPolicy({ ...basePolicy, defaultAction: 'block' });
    expect((await evaluatePolicy('unknown', 'search', {})).action).toBe('block');
  });

  it('escalates critical block rules to halt when haltOnCritical is set', async () => {
    setPolicy({
      version: 1,
      environments: { staging: { haltOnCritical: true }, production: { haltOnCritical: true } },
      agents: [{ id: 'a', rules: [{ id: 'r', action: 'block', severity: 'critical', condition: { tool: 'x' } }] }],
    });
    expect((await evaluatePolicy('a', 'x', {})).action).toBe('halt_agent');
  });

  it('does not resolve condition paths through the prototype chain', async () => {
    setPolicy({ version: '1', agents: [{ id: 'a', rules: [{ id: 'r', action: 'block', condition: { 'constructor.name': 'Object' } }] }] });
    expect((await evaluatePolicy('a', 'x', {})).action).toBe('allow');
  });
});

describe('loading fails closed', () => {
  it('loads a valid YAML file', async () => {
    loadPolicyFile(policyFile('ok.yaml', `
version: "1.0"
agents:
  - id: a
    rules:
      - id: no-delete
        action: block
        condition: { tool: deleteUser }
`));
    expect((await evaluatePolicy('a', 'deleteUser', {})).action).toBe('block');
  });

  it.each([
    ['malformed YAML', 'version: "1.0"\nagents:\n  - id: a\n    rules: [ { id: r\n'],
    ['unknown action', 'version: "1.0"\nagents:\n  - id: a\n    rules:\n      - { id: r, action: deny, condition: { tool: x } }\n'],
    ['misspelled rule key', 'version: "1.0"\nagents:\n  - id: a\n    rules:\n      - { id: r, acton: block, condition: { tool: x } }\n'],
    ['misspelled constraint', 'version: "1.0"\nagents:\n  - id: a\n    rules:\n      - { id: r, action: block, condition: { amount: { greater_than: 5 } } }\n'],
    ['missing version', 'agents: []\n'],
    ['empty file', ''],
  ])('rejects %s and keeps the previous policy active', async (name, yaml) => {
    const file = policyFile(`${name.replace(/\s/g, '-')}.yaml`, yaml);
    expect(() => loadPolicyFile(file)).toThrow(PolicyLoadError);
    expect(validatePolicyFile(file).valid).toBe(false);
    // basePolicy from beforeEach is still enforced
    expect((await evaluatePolicy('x', 'dropDatabase', {})).action).toBe('halt_agent');
  });

  it('rejects a missing file', () => {
    expect(() => loadPolicyFile(path.join(dir, 'nope.yaml'))).toThrow(PolicyLoadError);
  });
});

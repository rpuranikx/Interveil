import { describe, it, expect, vi } from 'vitest';
import { evaluatePolicy, loadPolicyFile, PolicyViolationError } from './engine.js';
import * as fs from 'fs';
import * as yaml from 'yaml';

vi.mock('fs');
vi.mock('yaml');

describe('Policy Engine', () => {
  describe('evaluatePolicy', () => {
    it('allows if no policy matches', async () => {
      vi.mocked(yaml.parse).mockReturnValue({});
      loadPolicyFile('dummy.yaml');
      const result = await evaluatePolicy('agent1', 'my_tool', { arg: 1 });
      expect(result.action).toBe('allow');
    });

    it('evaluates conditions properly', async () => {
      vi.mocked(yaml.parse).mockReturnValue({
        version: '1.0',
        agents: [
          {
            id: 'agent1',
            rules: [
              {
                id: 'rule1',
                action: 'block',
                condition: {
                  tool: 'my_tool',
                  'input.val': { greaterThan: 10 }
                }
              }
            ]
          }
        ]
      });
      loadPolicyFile('dummy.yaml');
      
      const allowedResult = await evaluatePolicy('agent1', 'my_tool', { input: { val: 5 } });
      expect(allowedResult.action).toBe('allow');

      const blockedResult = await evaluatePolicy('agent1', 'my_tool', { input: { val: 15 } });
      expect(blockedResult.action).toBe('block');
    });

    it('halts agent on critical violations when configured', async () => {
        vi.mocked(yaml.parse).mockReturnValue({
            version: '1.0',
            environments: {
                staging: { haltOnCritical: true },
                production: { haltOnCritical: true }
            },
            agents: [
                {
                    id: 'agent1',
                    rules: [
                        {
                            id: 'rule1',
                            action: 'halt_agent',
                            severity: 'critical',
                            condition: { tool: 'dangerous_tool' }
                        }
                    ]
                }
            ]
        });
        loadPolicyFile('dummy.yaml');
        
        await expect(evaluatePolicy('agent1', 'dangerous_tool', {}))
            .rejects.toThrow(PolicyViolationError);
    });
  });
});

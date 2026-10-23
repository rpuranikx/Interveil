import { describe, it, expect } from 'vitest';
import { checkCommand, extractStrings } from './blocklist.js';

describe('blocklist', () => {
  describe('extractStrings', () => {
    it('extracts strings from primitives', () => {
      expect(extractStrings('hello')).toEqual(['hello']);
      expect(extractStrings(123)).toEqual(['123']);
      expect(extractStrings(true)).toEqual(['true']);
    });

    it('extracts strings from nested arrays and objects', () => {
      const obj = {
        a: 'test1',
        b: ['test2', 456],
        c: {
          d: 'test3'
        }
      };
      const strings = extractStrings(obj);
      expect(strings).toContain('test1');
      expect(strings).toContain('test2');
      expect(strings).toContain('456');
      expect(strings).toContain('test3');
    });

    it('caps depth', () => {
      const deepObj: any = {};
      let current = deepObj;
      for (let i = 0; i < 10; i++) {
        current.next = { val: `level${i}` };
        current = current.next;
      }
      const strings = extractStrings(deepObj);
      expect(strings).not.toContain('level9');
    });
  });

  describe('checkCommand', () => {
    it('blocks default dangerous commands', () => {
      expect(checkCommand('rm -rf /').matched).toBe(true);
      expect(checkCommand('DROP TABLE users;').matched).toBe(true);
      expect(checkCommand('chmod 777 /etc').matched).toBe(true);
      expect(checkCommand('wget | bash').matched).toBe(true);
    });

    it('allows safe commands by default', () => {
      expect(checkCommand('ls -la').matched).toBe(false);
      expect(checkCommand('SELECT * FROM users;').matched).toBe(false);
    });

    it('respects user block rules', () => {
      const config = { block: ['dangerous_tool'] };
      expect(checkCommand('use dangerous_tool', config).matched).toBe(true);
      expect(checkCommand('use dangerous_tool', config).source).toBe('user_config');
    });

    it('respects user whitelist over block rules', () => {
      const config = { whitelist: ['rm -rf /tmp'], block: ['rm -rf'] };
      expect(checkCommand('rm -rf /tmp', config).matched).toBe(false);
      expect(checkCommand('rm -rf /tmp', config).source).toBe('whitelisted');
    });

    it('respects requireApproval rules', () => {
      const config = { requireApproval: ['deploy'] };
      expect(checkCommand('npm run deploy', config).matched).toBe(true);
      expect(checkCommand('npm run deploy', config).source).toBe('approval_required');
    });
  });
});

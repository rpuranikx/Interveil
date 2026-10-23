import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { checkCommand, extractStrings, MAX_SCANNED_STRINGS } from './blocklist.js';

const cases = JSON.parse(
  readFileSync(path.join(__dirname, '../../test-fixtures/blocklist-cases.json'), 'utf-8'),
) as { block: string[]; allow: string[] };

describe('default rules', () => {
  it.each(cases.block)('blocks %j', (cmd) => {
    expect(checkCommand(cmd).matched).toBe(true);
  });

  it.each(cases.allow)('allows %j', (cmd) => {
    expect(checkCommand(cmd)).toMatchObject({ matched: false });
  });
});

describe('deep scanning', () => {
  it('finds strings in nested arrays, objects and object keys', () => {
    const strings = extractStrings({ a: 'x', b: ['y', 4], c: { d: true } }) ?? [];
    expect(strings).toEqual(expect.arrayContaining(['x', 'y', '4', 'true', 'a', 'd']));
    expect(checkCommand({ 'rm -rf /': 1 }).matched).toBe(true);
  });

  it('has no depth limit to hide a payload behind', () => {
    let deep: unknown = { cmd: 'rm -rf /' };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(checkCommand(deep).matched).toBe(true);
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { cmd: 'ls' };
    a.self = a;
    expect(checkCommand(a).matched).toBe(false);
    a.payload = 'drop table users';
    expect(checkCommand(a).matched).toBe(true);
  });

  it('blocks values too large to scan instead of skipping them', () => {
    const huge = Array.from({ length: MAX_SCANNED_STRINGS + 1 }, () => 'ok');
    expect(checkCommand(huge)).toMatchObject({ matched: true, source: 'scan_limit' });
  });
});

describe('user config', () => {
  it('blocks user patterns', () => {
    expect(checkCommand('use dangerous_tool', { block: ['dangerous_tool'] }))
      .toMatchObject({ matched: true, source: 'user_config' });
  });

  it('flags require-approval patterns', () => {
    expect(checkCommand('npm run deploy', { requireApproval: ['deploy'] }))
      .toMatchObject({ matched: true, source: 'approval_required' });
  });

  it('exempts an exactly whitelisted command', () => {
    expect(checkCommand('rm -rf /tmp/build', { whitelist: ['rm -rf /tmp/build'] }).matched).toBe(false);
  });

  it('does not let a whitelisted command carry a chained one', () => {
    const whitelist = ['rm -rf /tmp/build'];
    expect(checkCommand('rm -rf /tmp/build && rm -rf /', { whitelist }).matched).toBe(true);
    expect(checkCommand('rm -rf /tmp/build; rm -rf ~', { whitelist }).matched).toBe(true);
    expect(checkCommand('rm -rf /tmp/build/../../', { whitelist }).matched).toBe(true);
  });

  it('keeps scanning other arguments after a whitelisted one', () => {
    expect(checkCommand(['ls', 'rm -rf /'], { whitelist: ['ls'] }).matched).toBe(true);
  });

  it('checks blocks before approvals so a chained block cannot be downgraded', () => {
    expect(checkCommand('deploy && rm -rf /', { requireApproval: ['deploy'] }))
      .toMatchObject({ matched: true, source: 'default_blocklist' });
  });
});

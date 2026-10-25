import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hookOutput, initClaudeCode } from './claude-code.js';

describe('hookOutput', () => {
  const url = 'http://localhost:3000';

  it('allows with no output', () => {
    expect(hookOutput({ ok: true, allowed: true }, url)).toBeNull();
  });

  it('asks for require_approval and denies everything else', () => {
    expect(hookOutput({ ok: true, allowed: false, approval_required: true, source: 'policy', rule_id: 'r', message: 'm' }, url)?.hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'ask' });
    expect(hookOutput({ ok: true, allowed: false, source: 'blocklist', rule_id: 'pipe-to-shell', message: 'm' }, url)?.hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny' });
  });

  it('fails closed with a way to start the server', () => {
    const out = hookOutput(null, url)?.hookSpecificOutput;
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('interveil serve --preset coding-agent');
  });
});

describe('initClaudeCode', () => {
  let dir: string;
  let settingsFile: string;
  const prevKeyFile = process.env.INTERVEIL_API_KEY_FILE;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interveil-init-'));
    settingsFile = path.join(dir, '.claude', 'settings.json');
    process.env.INTERVEIL_API_KEY_FILE = path.join(dir, 'api-key');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKeyFile === undefined) delete process.env.INTERVEIL_API_KEY_FILE;
    else process.env.INTERVEIL_API_KEY_FILE = prevKeyFile;
  });

  const init = (extra: Partial<Parameters<typeof initClaudeCode>[0]> = {}) => initClaudeCode({
    settingsFile, cliPath: '/opt/interveil/dist/cli.js', url: 'http://localhost:3000', agentId: 'claude-code', key: true, ...extra,
  });

  it('keeps existing settings, adds the hook once, and creates a key', () => {
    fs.mkdirSync(path.dirname(settingsFile));
    fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }));

    const first = init();
    expect(first).toMatchObject({ replaced: false, keyCreated: true });
    const second = init({ url: 'http://localhost:4000' });
    expect(second).toMatchObject({ replaced: true, keyCreated: false });

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    const commands = settings.hooks.PreToolUse.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map(h => h.command));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('/opt/interveil/dist/cli.js" hook claude-code --url http://localhost:4000');
    expect(fs.readFileSync(path.join(dir, 'api-key'), 'utf-8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves a settings file it cannot parse alone', () => {
    fs.mkdirSync(path.dirname(settingsFile));
    fs.writeFileSync(settingsFile, '{ not json');
    expect(() => init()).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{ not json');
  });
});

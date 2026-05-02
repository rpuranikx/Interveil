import { spawn, SpawnOptions } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../ws/broadcaster.js';
import { checkCommand, UserCommandConfig } from './blocklist.js';

export { checkCommand };

export interface CommandInterceptorOptions {
  userConfig?: UserCommandConfig;
  dryRun?: boolean;
  sessionId?: string;
  onBlock?: (event: BlockEvent) => void;
  webhooks?: string[];
}

export interface BlockEvent {
  event_id: string;
  session_id: string;
  step_type: 'COMMAND_BLOCKED' | 'COMMAND_DRY_RUN';
  blocked_command: string;
  matched_rule: string;
  rule_source: string;
  timestamp: string;
}

async function postWebhook(url: string, payload: BlockEvent): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, source: 'interveil' }),
    });
  } catch {
    // Webhooks are best-effort
  }
}

export function interceptChildProcess(options: CommandInterceptorOptions = {}) {
  const { userConfig = {}, dryRun = false, sessionId = uuidv4(), webhooks = [] } = options;

  function safeSpawn(command: string, args: string[] = [], spawnOptions: SpawnOptions = {}) {
    const fullCommand = [command, ...args].join(' ');
    const check = checkCommand(fullCommand, userConfig);

    if (dryRun) {
      const event: BlockEvent = {
        event_id: uuidv4(),
        session_id: sessionId,
        step_type: 'COMMAND_DRY_RUN',
        blocked_command: fullCommand,
        matched_rule: 'DRY_RUN_MODE',
        rule_source: 'dry_run',
        timestamp: new Date().toISOString(),
      };
      broadcast(event as unknown as Record<string, unknown>);
      console.log(`[Interveil] DRY RUN — would have executed: ${fullCommand}`);

      const mockChild = {
        stdout: { on: () => {}, pipe: () => {} },
        stderr: { on: () => {}, pipe: () => {} },
        on: (evt: string, cb: (code: number) => void) => { if (evt === 'close') setTimeout(() => cb(0), 0); },
        kill: () => {},
        pid: undefined,
      };
      return mockChild;
    }

    if (check.matched) {
      const event: BlockEvent = {
        event_id: uuidv4(),
        session_id: sessionId,
        step_type: 'COMMAND_BLOCKED',
        blocked_command: fullCommand,
        matched_rule: check.rule,
        rule_source: check.source,
        timestamp: new Date().toISOString(),
      };

      broadcast(event as unknown as Record<string, unknown>);
      if (options.onBlock) options.onBlock(event);
      for (const url of webhooks) void postWebhook(url, event);

      console.warn(`[Interveil] BLOCKED: ${fullCommand} (rule: ${check.rule})`);
      throw new Error(`Command blocked by Interveil: ${check.rule}`);
    }

    return spawn(command, args, spawnOptions);
  }

  return { safeSpawn };
}

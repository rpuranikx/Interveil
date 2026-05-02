import { v4 as uuidv4 } from 'uuid';
import { InterveillClient } from './client.js';
import { evaluatePolicy, loadPolicyFile, PolicyViolationError } from '../policy/engine.js';
import { checkCommand, UserCommandConfig } from '../commands/blocklist.js';

export { PolicyViolationError };

export interface TraceOptions {
  port?: number;
  host?: string;
  autoOpen?: boolean;
  sessionName?: string;
  agentId?: string;
  verbose?: boolean;
  /**
   * When true, every method call is intercepted and recorded as COMMAND_DRY_RUN
   * but the underlying method is NEVER executed. Useful for testing policies.
   */
  dryRun?: boolean;
  /**
   * Path to a policy YAML file. When provided, every method call is evaluated
   * against the policy rules BEFORE the method executes. Blocked calls throw
   * PolicyViolationError and are never executed.
   */
  policyFile?: string;
  /**
   * Command blocklist config. Any string argument that matches a blocked pattern
   * causes the method to be rejected before it runs.
   */
  commandConfig?: UserCommandConfig;
}

function inferStepType(methodName: string): string {
  const name = methodName.toLowerCase();
  if (/think|reason|plan|reflect/.test(name)) return 'REASONING';
  if (/complete|chat|message|generate|predict/.test(name)) return 'LLM_REQUEST';
  if (/call|invoke|run|execute|use/.test(name)) return 'TOOL_CALL';
  return 'CUSTOM';
}

let browserOpened = false;

async function tryOpenBrowser(url: string): Promise<void> {
  if (browserOpened) return;
  browserOpened = true;
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {
    // Best-effort
  }
}

// ── Global signal handler registry ───────────────────────────────────────────
type CleanupFn = (status: 'completed' | 'failed') => Promise<void>;
const cleanupRegistry = new Set<CleanupFn>();
let globalHandlersRegistered = false;

function ensureGlobalHandlers(): void {
  if (globalHandlersRegistered) return;
  globalHandlersRegistered = true;

  const runAll = async (status: 'completed' | 'failed') => {
    await Promise.allSettled([...cleanupRegistry].map(fn => fn(status)));
  };

  process.on('exit', () => { void runAll('completed'); });
  process.on('SIGINT', async () => { await runAll('completed'); process.exit(0); });
  process.on('SIGTERM', async () => { await runAll('completed'); process.exit(0); });
  process.on('uncaughtException', async (err: Error) => {
    console.error('[Interveil] Uncaught exception — marking session failed:', err);
    await runAll('failed');
    process.exit(1);
  });
}
// ─────────────────────────────────────────────────────────────────────────────

export function trace<T extends object>(agent: T, options: TraceOptions = {}): T {
  const client = new InterveillClient({ port: options.port, host: options.host });
  const sessionName = options.sessionName ?? new Date().toISOString();
  const autoOpen = options.autoOpen !== false;
  const verbose = options.verbose ?? false;
  const baseUrl = `http://${options.host ?? 'localhost'}:${options.port ?? 3000}`;
  const agentId = options.agentId ?? 'default';

  // Load policy file once at trace() call time, not on every method invocation
  if (options.policyFile) {
    loadPolicyFile(options.policyFile);
  }

  let stepIndex = 0;
  let sessionStatus: 'running' | 'completed' | 'failed' = 'running';

  const initSession = async () => {
    const session = await client.startSession({ name: sessionName, agent_id: options.agentId });
    return session.session_id;
  };

  const ensureSession = (() => {
    let promise: Promise<string> | null = null;
    return () => { if (!promise) promise = initSession(); return promise; };
  })();

  const cleanup: CleanupFn = async (status) => {
    if (sessionStatus !== 'running') return;
    sessionStatus = status;
    const sid = await ensureSession();
    await client.endSession(sid, status);
    cleanupRegistry.delete(cleanup);
  };

  cleanupRegistry.add(cleanup);
  ensureGlobalHandlers();

  return new Proxy(agent, {
    get(target: T, prop: string | symbol) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;

      return async (...args: unknown[]) => {
        const methodName = String(prop);
        const timestamp = new Date().toISOString();
        const sid = await ensureSession();
        const currentStep = stepIndex++;
        const stepType = inferStepType(methodName);

        if (verbose) {
          console.log(`[Interveil] ${methodName} → ${stepType} (step ${currentStep})`);
        }

        // ── PRE-EXECUTION: dryRun global flag ──────────────────────────────
        if (options.dryRun) {
          await client.emit({
            session_id: sid,
            step_index: currentStep,
            step_type: 'COMMAND_DRY_RUN',
            input: { method: methodName, args },
            output: null,
            timestamp,
            duration_ms: 0,
            metadata: { dry_run: true },
          });
          if (verbose) console.log(`[Interveil] DRY RUN — ${methodName} not executed`);
          return null;
        }

        // ── PRE-EXECUTION: command blocklist ───────────────────────────────
        // Scan every string argument against the blocklist and user config.
        // A single match is enough to block the entire call.
        const stringArgs = args.filter((a): a is string => typeof a === 'string');
        for (const arg of stringArgs) {
          const check = checkCommand(arg, options.commandConfig);
          if (check.matched) {
            const severity = check.source === 'default_blocklist' ? 'high' : 'medium';
            await client.emit({
              session_id: sid,
              step_index: currentStep,
              step_type: 'COMMAND_BLOCKED',
              input: { method: methodName, args },
              output: null,
              timestamp,
              duration_ms: 0,
              metadata: {
                blocked_pattern: check.rule,
                source: check.source,
                severity,
                reason: `Argument matched ${check.source} pattern: "${check.rule}"`,
              },
            });
            if (verbose) {
              console.warn(`[Interveil] BLOCKED — ${methodName}() arg matched "${check.rule}" (${check.source})`);
            }
            throw new PolicyViolationError(
              check.rule,
              agentId,
              methodName,
              severity,
              `[Interveil] Command blocked — argument matched ${check.source} pattern: "${check.rule}"`,
            );
          }
        }

        // ── PRE-EXECUTION: policy engine ───────────────────────────────────
        // Evaluate the named policy rules for this agent + method before running.
        if (options.policyFile) {
          const policyResult = await evaluatePolicy(agentId, methodName, { args }, sid);

          if (policyResult.action === 'block' || policyResult.action === 'halt_agent') {
            const ruleId = policyResult.rule?.id ?? 'unknown-rule';
            const ruleSeverity = policyResult.rule?.severity ?? 'high';
            await client.emit({
              session_id: sid,
              step_index: currentStep,
              step_type: 'COMMAND_BLOCKED',
              input: { method: methodName, args },
              output: null,
              timestamp,
              duration_ms: 0,
              metadata: {
                rule_id: ruleId,
                policy_action: policyResult.action,
                severity: ruleSeverity,
                reason: policyResult.rule?.message ?? `Policy rule "${ruleId}" blocked this call`,
              },
            });
            if (verbose) {
              console.warn(`[Interveil] BLOCKED — ${methodName}() by policy rule "${ruleId}" (${policyResult.action})`);
            }
            throw new PolicyViolationError(
              ruleId,
              agentId,
              methodName,
              ruleSeverity,
              `[Interveil] Blocked by policy rule "${ruleId}": ${policyResult.rule?.message ?? policyResult.action}`,
            );
          }

          if (policyResult.action === 'require_approval') {
            // Emit a TOOL_PERMISSION_DENIED event and block until the feature
            // is extended with an interactive approval UI. For now, block the call
            // and let the caller know.
            await client.emit({
              session_id: sid,
              step_index: currentStep,
              step_type: 'TOOL_PERMISSION_DENIED',
              input: { method: methodName, args },
              output: null,
              timestamp,
              duration_ms: 0,
              metadata: {
                rule_id: policyResult.rule?.id,
                reason: 'require_approval — interactive approval not yet enabled',
              },
            });
            throw new PolicyViolationError(
              policyResult.rule?.id ?? 'require_approval',
              agentId,
              methodName,
              policyResult.rule?.severity ?? 'medium',
              `[Interveil] "${methodName}" requires human approval before it can run`,
            );
          }
          // allow / allow_and_audit: proceed normally (audit event already broadcast by evaluatePolicy)
        }

        // ── EXECUTION ──────────────────────────────────────────────────────
        let result: unknown;
        let errorObj: unknown = undefined;
        let finalStepType = stepType;

        try {
          result = await (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          errorObj = err instanceof Error
            ? { message: err.message, stack: err.stack, name: err.name }
            : err;
          finalStepType = 'ERROR';
          result = null;
        }

        const duration_ms = Date.now() - (new Date(timestamp).getTime());

        await client.emit({
          session_id: sid,
          step_index: currentStep,
          step_type: finalStepType,
          input: { method: methodName, args },
          output: result,
          timestamp,
          duration_ms,
          ...(errorObj !== undefined ? { error: errorObj } : {}),
        });

        if (autoOpen && currentStep === 0) {
          void tryOpenBrowser(baseUrl);
        }

        if (errorObj !== undefined) throw errorObj;

        if (stepType === 'LLM_REQUEST') {
          await client.emit({
            session_id: sid,
            step_index: stepIndex++,
            step_type: 'LLM_RESPONSE',
            input: null,
            output: result,
            timestamp: new Date().toISOString(),
            duration_ms,
          });
        }

        return result;
      };
    },
  }) as T;
}

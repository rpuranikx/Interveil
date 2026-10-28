import { InterveillClient } from './client.js';
import { evaluatePolicy, loadPolicyFile, PolicyViolationError } from '../policy/engine.js';
import { checkCommand, UserCommandConfig } from '../commands/blocklist.js';
import { log } from '../log.js';
import { hasRegisteredTool, callTool } from '../tools/registry.js';

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

function inferStepType(methodName: string, isRegisteredTool: boolean): string {
  if (isRegisteredTool) return 'TOOL_CALL';
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
    log.error('Uncaught exception — marking session failed:', err);
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

  // Throws PolicyLoadError on a missing or invalid file, so an agent is never
  // wrapped with a policy that is not actually being enforced.
  if (options.policyFile) {
    loadPolicyFile(options.policyFile);
  }

  let stepIndex = 0;
  /** Set when a halt_agent rule fires; every later call is refused. */
  let haltedBy: string | null = null;
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
    get(target: T, prop: string | symbol, receiver: unknown) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;

      return async (...args: unknown[]) => {
        const methodName = String(prop);
        if (haltedBy !== null) {
          throw new PolicyViolationError(
            haltedBy, agentId, methodName, 'critical',
            `[Interveil] Agent "${agentId}" was halted by policy rule "${haltedBy}"; ${methodName}() refused`,
          );
        }
        const timestamp = new Date().toISOString();
        const sid = await ensureSession();
        const currentStep = stepIndex++;
        const isTool = hasRegisteredTool(methodName);
        const stepType = inferStepType(methodName, isTool);

        if (verbose) {
          const label = isTool ? 'TOOL (registered)' : stepType;
          console.log(`[Interveil] ${methodName} → ${label} (step ${currentStep})`);
        }

        // ── PRE-EXECUTION: dryRun ──────────────────────────────────────────
        if (options.dryRun) {
          await client.emit({
            session_id: sid,
            step_index: currentStep,
            step_type: 'COMMAND_DRY_RUN',
            input: { method: methodName, args },
            output: null,
            timestamp,
            duration_ms: 0,
            metadata: { dry_run: true, is_registered_tool: isTool },
          });
          if (verbose) console.log(`[Interveil] DRY RUN — ${methodName} not executed`);
          return null;
        }

        // ── PRE-EXECUTION: command blocklist ───────────────────────────────
        // checkCommand deep-scans every arg — strings directly, objects and
        // arrays recursively — so { cmd: 'rm -rf /' } is caught just like 'rm -rf /'.
        const check = checkCommand(args, options.commandConfig);
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
            metadata: { blocked_pattern: check.rule, source: check.source, severity, matched_value: check.matchedValue },
          });
          if (verbose) console.warn(`[Interveil] BLOCKED — ${methodName}() matched "${check.rule}" (${check.source})`);
          throw new PolicyViolationError(
            check.rule, agentId, methodName, severity,
            `[Interveil] Command blocked — argument matched ${check.source} rule "${check.rule}"`,
          );
        }

        // ── PRE-EXECUTION: YAML policy engine ─────────────────────────────
        if (options.policyFile) {
          const policyResult = await evaluatePolicy(agentId, methodName, { args });
          const ruleId = policyResult.rule?.id ?? 'defaultAction';

          if (policyResult.action === 'block' || policyResult.action === 'halt_agent') {
            const ruleSeverity = policyResult.rule?.severity ?? 'high';
            const halt = policyResult.action === 'halt_agent';
            await client.emit({
              session_id: sid,
              step_index: currentStep,
              step_type: 'POLICY_VIOLATION',
              input: { method: methodName, args },
              output: null,
              timestamp,
              duration_ms: 0,
              metadata: {
                rule_id: ruleId,
                agent_id: agentId,
                policy_action: policyResult.action,
                severity: ruleSeverity,
                message: policyResult.rule?.message,
              },
            });
            if (verbose) console.warn(`[Interveil] ${halt ? 'HALTED' : 'BLOCKED'} — ${methodName}() by policy rule "${ruleId}"`);
            if (halt) {
              haltedBy = ruleId;
              await cleanup('failed');
            }
            throw new PolicyViolationError(
              ruleId, agentId, methodName, ruleSeverity,
              `[Interveil] ${halt ? 'Agent halted' : 'Blocked'} by policy rule "${ruleId}": ${policyResult.rule?.message ?? policyResult.action}`,
            );
          }

          if (policyResult.action === 'allow_and_audit') {
            await client.emit({
              session_id: sid,
              step_index: stepIndex++,
              step_type: 'POLICY_AUDIT',
              input: { method: methodName, args },
              output: null,
              timestamp,
              duration_ms: 0,
              metadata: { rule_id: ruleId, agent_id: agentId, severity: policyResult.rule?.severity },
            });
          }

          if (policyResult.action === 'require_approval') {
            await client.emit({
              session_id: sid,
              step_index: currentStep,
              step_type: 'TOOL_PERMISSION_DENIED',
              input: { method: methodName, args },
              output: null,
              timestamp,
              duration_ms: 0,
              metadata: { rule_id: policyResult.rule?.id, reason: 'require_approval' },
            });
            throw new PolicyViolationError(
              policyResult.rule?.id ?? 'require_approval',
              agentId, methodName, policyResult.rule?.severity ?? 'medium',
              `[Interveil] "${methodName}" requires human approval before it can run`,
            );
          }
          // allow / allow_and_audit: proceed
        }

        // ── EXECUTION ──────────────────────────────────────────────────────
        // If the method name matches a registered tool, route through the tool
        // registry — which enforces its own per-tool access control (allow/deny
        // permissions, input conditions, Zod schema) before the handler runs.
        // Otherwise call the agent method directly.
        let result: unknown;
        let errorObj: unknown = undefined;
        let thrownError: unknown = undefined;
        let finalStepType = stepType;

        // Normalise args for tool input: single-object calls pass through
        // as-is; multi-arg or primitive calls are wrapped in { args }.
        const toolInput = isTool
          ? (args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? args[0] : { args })
          : null;

        try {
          if (isTool && toolInput !== null) {
            if (verbose) console.log(`[Interveil] Validating ${methodName} input against its registered schema`);
            result = await callTool(methodName, toolInput);
          } else {
            // `this` is the proxy, so a method that calls `this.refund()` is checked too,
            // not just the call the caller made. (Classes using #private fields can't
            // run with a proxy as `this`; wrap their public methods in an object instead.)
            result = await Reflect.apply(value as (...a: unknown[]) => unknown, receiver, args);
          }
        } catch (err) {
          thrownError = err;
          errorObj = err instanceof Error
            ? { message: err.message, stack: err.stack, name: err.name }
            : err;
          finalStepType = 'ERROR';
          result = null;
        }

        const duration_ms = Date.now() - new Date(timestamp).getTime();

        await client.emit({
          session_id: sid,
          step_index: currentStep,
          step_type: finalStepType,
          input: isTool ? { method: methodName, tool_input: toolInput } : { method: methodName, args },
          output: result,
          timestamp,
          duration_ms,
          ...(errorObj !== undefined ? { error: errorObj } : {}),
          ...(isTool ? { metadata: { registered_tool: true, agent_id: agentId } } : {}),
        });

        if (autoOpen && currentStep === 0) {
          void tryOpenBrowser(baseUrl);
        }

        if (errorObj !== undefined) throw thrownError;

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

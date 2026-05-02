import { v4 as uuidv4 } from 'uuid';
import { InterveillClient } from './client.js';

export interface TraceOptions {
  port?: number;
  host?: string;
  autoOpen?: boolean;
  sessionName?: string;
  agentId?: string;
  verbose?: boolean;
  dryRun?: boolean;
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
    // Silently ignore — browser open is best-effort
  }
}

export function trace<T extends object>(agent: T, options: TraceOptions = {}): T {
  const client = new InterveillClient({ port: options.port, host: options.host });
  const sessionName = options.sessionName ?? new Date().toISOString();
  const autoOpen = options.autoOpen !== false;
  const verbose = options.verbose ?? false;
  const baseUrl = `http://${options.host ?? 'localhost'}:${options.port ?? 3000}`;

  let sessionId: string | null = null;
  let stepIndex = 0;
  let sessionStatus: 'running' | 'completed' | 'failed' = 'running';

  const initSession = async () => {
    const session = await client.startSession({
      name: sessionName,
      agent_id: options.agentId,
    });
    sessionId = session.session_id;
    return sessionId;
  };

  const ensureSession = (() => {
    let promise: Promise<string> | null = null;
    return () => {
      if (!promise) promise = initSession();
      return promise;
    };
  })();

  const cleanup = async (status: 'completed' | 'failed') => {
    if (sessionStatus !== 'running') return;
    sessionStatus = status;
    const sid = await ensureSession();
    await client.endSession(sid, status);
  };

  process.on('exit', () => { void cleanup('completed'); });
  process.on('SIGINT', async () => { await cleanup('completed'); process.exit(0); });
  process.on('SIGTERM', async () => { await cleanup('completed'); process.exit(0); });
  process.on('uncaughtException', async () => { await cleanup('failed'); process.exit(1); });

  return new Proxy(agent, {
    get(target: T, prop: string | symbol) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;

      return async (...args: unknown[]) => {
        const methodName = String(prop);
        const timestamp = new Date().toISOString();
        const start = Date.now();

        const sid = await ensureSession();
        const currentStep = stepIndex++;
        const stepType = inferStepType(methodName);

        if (verbose) {
          console.log(`[Interveil] ${methodName} → ${stepType} (step ${currentStep})`);
        }

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

        const duration_ms = Date.now() - start;

        const eventPayload = {
          session_id: sid,
          step_index: currentStep,
          step_type: finalStepType,
          input: { method: methodName, args },
          output: result,
          timestamp,
          duration_ms,
          ...(errorObj !== undefined ? { error: errorObj } : {}),
        };

        await client.emit(eventPayload);

        if (autoOpen && currentStep === 0) {
          void tryOpenBrowser(baseUrl);
        }

        if (errorObj !== undefined) {
          throw errorObj;
        }

        if (stepType === 'LLM_REQUEST') {
          const responseStep = stepIndex++;
          await client.emit({
            session_id: sid,
            step_index: responseStep,
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

/**
 * Diagnostics for the server and SDKs, filtered by INTERVEIL_LOG_LEVEL
 * (debug | info | warn | error | silent; default info). Read on every call so
 * the level can be changed by the embedding process at any time.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

function enabled(level: Level): boolean {
  const configured = (process.env.INTERVEIL_LOG_LEVEL ?? 'info') as Level;
  return LEVELS[level] >= (LEVELS[configured] ?? LEVELS.info);
}

export const log = {
  debug: (message: string, ...rest: unknown[]) => { if (enabled('debug')) console.debug(`[Interveil] ${message}`, ...rest); },
  info: (message: string, ...rest: unknown[]) => { if (enabled('info')) console.info(`[Interveil] ${message}`, ...rest); },
  warn: (message: string, ...rest: unknown[]) => { if (enabled('warn')) console.warn(`[Interveil] ${message}`, ...rest); },
  error: (message: string, ...rest: unknown[]) => { if (enabled('error')) console.error(`[Interveil] ${message}`, ...rest); },
};

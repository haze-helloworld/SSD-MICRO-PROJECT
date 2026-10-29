const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;
type Level = keyof typeof LEVELS;

export function makeLogger(base: Record<string, unknown> = {}) {
  const min = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
  const emit = (lvl: Level, msg: string, extra?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), lvl, msg, ...base, ...extra }) + '\n');
  };
  return {
    debug: (m: string, e?: Record<string, unknown>) => emit('debug', m, e),
    info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
    warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
    error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
  };
}
export type Logger = ReturnType<typeof makeLogger>;

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: Level;
  message: string;
  time: number;
}

const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];

function push(level: Level, message: string, extra: unknown[]): void {
  entries.push({ level, message, time: Date.now() });
  if (entries.length > MAX_ENTRIES) entries.shift();
  const fn =
    level === 'debug'
      ? console.debug
      : level === 'info'
        ? console.info
        : level === 'warn'
          ? console.warn
          : console.error;
  fn(`[Zino3D] ${message}`, ...extra);
}

/** Local-only logger. Nothing is transmitted anywhere. */
export const log = {
  debug: (message: string, ...extra: unknown[]) => push('debug', message, extra),
  info: (message: string, ...extra: unknown[]) => push('info', message, extra),
  warn: (message: string, ...extra: unknown[]) => push('warn', message, extra),
  error: (message: string, ...extra: unknown[]) => push('error', message, extra),
  recent: (): readonly LogEntry[] => entries,
};

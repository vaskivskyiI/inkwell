const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const min = () => LEVELS[process.env.INKWELL_LOG_LEVEL || 'info'] ?? 20;

export function logger(name) {
  const out = (level) => (...args) => {
    if (LEVELS[level] < min()) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${name}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}

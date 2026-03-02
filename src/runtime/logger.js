import util from 'util';

const LEVEL_ORDER = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

function toLevel(level) {
  if (!level) {
    return 'info';
  }

  const normalized = String(level).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_ORDER, normalized) ? normalized : 'info';
}

export function createLogger({ level = 'info', name = 'aegisnode' } = {}) {
  const currentLevel = toLevel(level);

  function shouldLog(candidateLevel) {
    return LEVEL_ORDER[candidateLevel] <= LEVEL_ORDER[currentLevel];
  }

  function formatLine(candidateLevel, message, args) {
    const timestamp = new Date().toISOString();
    const rendered = util.format(message, ...args);
    return [`[${timestamp}]`, `[${name}]`, `[${candidateLevel.toUpperCase()}]`, rendered];
  }

  return {
    level: currentLevel,
    error(message, ...args) {
      if (!shouldLog('error')) return;
      console.error(...formatLine('error', message, args));
    },
    warn(message, ...args) {
      if (!shouldLog('warn')) return;
      console.warn(...formatLine('warn', message, args));
    },
    info(message, ...args) {
      if (!shouldLog('info')) return;
      console.info(...formatLine('info', message, args));
    },
    debug(message, ...args) {
      if (!shouldLog('debug')) return;
      console.debug(...formatLine('debug', message, args));
    },
    trace(message, ...args) {
      if (!shouldLog('trace')) return;
      console.debug(...formatLine('trace', message, args));
    },
  };
}

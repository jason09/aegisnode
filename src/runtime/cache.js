class MemoryCache {
  constructor() {
    this.storage = new Map();
  }

  set(key, value) {
    this.storage.set(key, value);
    return value;
  }

  get(key) {
    return this.storage.get(key);
  }

  delete(key) {
    return this.storage.delete(key);
  }

  clear() {
    this.storage.clear();
  }
}

export function createCache(cacheConfig, logger) {
  if (!cacheConfig?.enabled) {
    logger.info('Cache disabled by configuration.');
    return null;
  }

  const driver = String(cacheConfig.driver || 'memory').toLowerCase();
  if (driver !== 'memory') {
    throw new Error(`Unsupported cache driver: ${driver}. Start with memory and add custom loader support.`);
  }

  logger.info('Cache initialized with driver %s', driver);
  return new MemoryCache();
}

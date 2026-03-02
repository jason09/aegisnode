import QueryMesh from 'querymesh';

const SQL_DIALECTS = new Set(['mysql', 'pg', 'postgres', 'postgresql', 'sqlite', 'mssql', 'oracle']);

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function asNonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeSqlDialect(dialect) {
  const normalized = String(dialect || '').toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql') {
    return 'pg';
  }
  return normalized;
}

function buildMongoUriFromConfig(mongoConfig) {
  const connectionString = asNonEmptyString(mongoConfig.connectionString, asNonEmptyString(mongoConfig.uri));
  if (connectionString) {
    return connectionString;
  }

  const host = asNonEmptyString(mongoConfig.server, asNonEmptyString(mongoConfig.host, 'localhost'));
  const rawPort = mongoConfig.port;
  const hasPort = rawPort !== undefined && rawPort !== null && String(rawPort).trim().length > 0;
  const port = hasPort ? `:${String(rawPort).trim()}` : '';
  const databaseName = asNonEmptyString(mongoConfig.database, asNonEmptyString(mongoConfig.dbName, 'appdb'));
  const username = asNonEmptyString(mongoConfig.user, asNonEmptyString(mongoConfig.username));
  const password = asNonEmptyString(mongoConfig.password);
  const credentials = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : '';

  return `mongodb://${credentials}${host}${port}/${encodeURIComponent(databaseName)}`;
}

function resolveMongoOptions(databaseConfig, mongoConfig) {
  if (isPlainObject(databaseConfig?.options)) {
    return databaseConfig.options;
  }

  if (isPlainObject(mongoConfig?.options)) {
    return mongoConfig.options;
  }

  if (isPlainObject(mongoConfig?.clientOptions)) {
    return mongoConfig.clientOptions;
  }

  return {};
}

function redactConnectionUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    return parsed.toString();
  } catch {
    return String(uri || '');
  }
}

export async function initializeDatabase(databaseConfig, logger) {
  if (!databaseConfig?.enabled) {
    logger.info('Database disabled by configuration.');
    return null;
  }

  const dialect = String(databaseConfig.dialect || '').toLowerCase();

  if (SQL_DIALECTS.has(dialect)) {
    const sqlDialect = normalizeSqlDialect(dialect);
    const client = await QueryMesh.connect({
      dialect: sqlDialect,
      config: databaseConfig.config || {},
    });

    logger.info('SQL database connected with dialect %s', sqlDialect);

    return {
      type: 'sql',
      dialect: sqlDialect,
      client,
    };
  }

  if (dialect === 'mongo' || dialect === 'mongodb') {
    let mongooseModule;
    try {
      mongooseModule = await import('mongoose');
    } catch (error) {
      throw new Error('MongoDB selected but mongoose is not available. Install mongoose in the project.');
    }

    const mongoose = mongooseModule.default ?? mongooseModule;
    const mongoConfig = isPlainObject(databaseConfig.config) ? databaseConfig.config : {};
    const legacyUri = asNonEmptyString(databaseConfig.uri);
    const uri = legacyUri || buildMongoUriFromConfig(mongoConfig);
    const options = resolveMongoOptions(databaseConfig, mongoConfig);
    const connection = await mongoose.connect(uri, options);

    logger.info('MongoDB connected at %s', redactConnectionUri(uri));

    return {
      type: 'nosql',
      dialect: 'mongodb',
      client: connection,
      mongoose,
    };
  }

  throw new Error(`Unsupported database dialect: ${dialect}`);
}

export async function closeDatabase(db) {
  if (!db) {
    return;
  }

  if (db.type === 'nosql' && db.mongoose?.connection?.close) {
    await db.mongoose.connection.close();
    return;
  }

  if (db.client && typeof db.client.close === 'function') {
    await db.client.close();
  }
}

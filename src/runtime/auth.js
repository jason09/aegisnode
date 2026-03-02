import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';

const SUPPORTED_PROVIDERS = new Set(['jwt', 'oauth2']);
const SUPPORTED_JWT_ALGORITHMS = new Set([
  'HS256',
  'HS384',
  'HS512',
]);
const SUPPORTED_STORAGE_DRIVERS = new Set(['cache', 'memory', 'file', 'database']);
const SUPPORTED_OAUTH2_GRANTS = new Set([
  'authorization_code',
  'client_credentials',
  'refresh_token',
]);
const SUPPORTED_OAUTH2_CLIENT_AUTH_METHODS = new Set([
  'client_secret_basic',
  'client_secret_post',
  'none',
]);
const SUPPORTED_OAUTH2_PKCE_METHODS = new Set(['S256', 'plain']);
const scryptAsync = promisify(crypto.scrypt);

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

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function normalizeRoutePath(value, fallback) {
  const candidate = asNonEmptyString(value, fallback);
  if (!candidate) {
    return fallback;
  }

  const withLeadingSlash = candidate.startsWith('/') ? candidate : `/${candidate}`;
  const cleaned = withLeadingSlash.replace(/\/+/g, '/');
  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    return cleaned.slice(0, -1);
  }
  return cleaned;
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asNonEmptyString(entry))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function sanitizeTablePrefix(value, fallback = 'aegisnode') {
  const candidate = asNonEmptyString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return candidate.length > 0 ? candidate : fallback;
}

function buildAuthTables(tablePrefix) {
  return {
    users: `${tablePrefix}_users`,
    jwtRevocations: `${tablePrefix}_jwt_revocations`,
    oauthClients: `${tablePrefix}_oauth_clients`,
    oauthAuthorizationCodes: `${tablePrefix}_oauth_authorization_codes`,
    oauthAccessTokens: `${tablePrefix}_oauth_access_tokens`,
    oauthRefreshTokens: `${tablePrefix}_oauth_refresh_tokens`,
  };
}

function normalizeJwtConfig(rawJwt, appName, appSecret) {
  const jwtConfig = isPlainObject(rawJwt) ? rawJwt : {};
  const configuredSecret = asNonEmptyString(jwtConfig.secret);
  const fallbackSecret = asNonEmptyString(appSecret);
  const algorithmCandidate = String(jwtConfig.algorithm || 'HS256').toUpperCase();
  const algorithm = SUPPORTED_JWT_ALGORITHMS.has(algorithmCandidate)
    ? algorithmCandidate
    : 'HS256';

  return {
    secret: configuredSecret || fallbackSecret,
    algorithm,
    issuer: asNonEmptyString(jwtConfig.issuer, appName || 'aegisnode'),
    audience: asNonEmptyString(jwtConfig.audience, appName || 'aegisnode'),
    expiresIn: asNonEmptyString(jwtConfig.expiresIn, '15m'),
    refreshExpiresIn: asNonEmptyString(jwtConfig.refreshExpiresIn, '7d'),
  };
}

function normalizeOAuth2GrantList(value) {
  const grants = uniqueStrings(
    asStringList(value)
      .map((entry) => entry.toLowerCase())
      .filter((entry) => SUPPORTED_OAUTH2_GRANTS.has(entry)),
  );

  if (grants.length > 0) {
    return grants;
  }

  return ['authorization_code', 'refresh_token', 'client_credentials'];
}

function normalizeOAuth2ClientAuthMethod(value, fallback = 'client_secret_basic') {
  const method = asNonEmptyString(value, fallback).toLowerCase();
  if (SUPPORTED_OAUTH2_CLIENT_AUTH_METHODS.has(method)) {
    return method;
  }
  return fallback;
}

function normalizeOAuth2Scopes(value) {
  return uniqueStrings(asStringList(value));
}

function normalizeOAuth2ServerConfig(rawServer, appName) {
  const server = isPlainObject(rawServer) ? rawServer : {};
  const basePath = normalizeRoutePath(server.basePath, '/oauth');
  const authorizePath = normalizeRoutePath(server.authorizePath, `${basePath}/authorize`);
  const tokenPath = normalizeRoutePath(server.tokenPath, `${basePath}/token`);
  const introspectionPath = normalizeRoutePath(server.introspectionPath, `${basePath}/introspect`);
  const revocationPath = normalizeRoutePath(server.revocationPath, `${basePath}/revoke`);
  const metadataPath = normalizeRoutePath(server.metadataPath, '/.well-known/oauth-authorization-server');

  return {
    enabled: server.enabled !== false,
    basePath,
    authorizePath,
    tokenPath,
    introspectionPath,
    revocationPath,
    metadataPath,
    issuer: asNonEmptyString(server.issuer, asNonEmptyString(server.baseUrl, appName || 'aegisnode')),
    autoApprove: server.autoApprove !== false,
    requireAuthenticatedUser: server.requireAuthenticatedUser !== false,
    requireConsent: asBoolean(server.requireConsent, false),
    allowSubjectFromParams: asBoolean(server.allowSubjectFromParams, false),
    allowHttp: asBoolean(server.allowHttp, false),
    resolveSubject: typeof server.resolveSubject === 'function' ? server.resolveSubject : null,
    resolveConsent: typeof server.resolveConsent === 'function' ? server.resolveConsent : null,
  };
}

function normalizeOAuth2Config(rawOAuth2, appName) {
  const oauth2 = isPlainObject(rawOAuth2) ? rawOAuth2 : {};

  return {
    accessTokenTtlSeconds: asPositiveInteger(oauth2.accessTokenTtlSeconds, 3600),
    refreshTokenTtlSeconds: asPositiveInteger(oauth2.refreshTokenTtlSeconds, 1209600),
    authorizationCodeTtlSeconds: asPositiveInteger(oauth2.authorizationCodeTtlSeconds, 600),
    rotateRefreshToken: oauth2.rotateRefreshToken !== false,
    requireClientSecret: oauth2.requireClientSecret !== false,
    requirePkce: oauth2.requirePkce !== false,
    allowPlainPkce: asBoolean(oauth2.allowPlainPkce, false),
    grants: normalizeOAuth2GrantList(oauth2.grants),
    defaultScopes: normalizeOAuth2Scopes(oauth2.defaultScopes),
    clientAuthMethod: normalizeOAuth2ClientAuthMethod(oauth2.clientAuthMethod, 'client_secret_basic'),
    server: normalizeOAuth2ServerConfig(oauth2.server, appName),
  };
}

function normalizeAuthStorageConfig(rawStorage, tablePrefix = 'aegisnode') {
  const storage = isPlainObject(rawStorage) ? rawStorage : {};
  const driverCandidate = String(storage.driver || 'cache').toLowerCase();
  const driver = SUPPORTED_STORAGE_DRIVERS.has(driverCandidate)
    ? driverCandidate
    : 'cache';
  const defaultStoreName = `${sanitizeTablePrefix(tablePrefix, 'aegisnode')}_auth_store`;
  const tableNameCandidate = asNonEmptyString(
    storage.tableName,
    asNonEmptyString(storage.collectionName, defaultStoreName),
  );

  return {
    driver,
    filePath: asNonEmptyString(storage.filePath, 'storage/aegisnode-auth-store.json'),
    tableName: sanitizeTablePrefix(tableNameCandidate, defaultStoreName),
  };
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asNonEmptyString(entry))
      .filter(Boolean)
      .join(' ');
  }

  if (typeof value === 'string') {
    return value
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function getNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function getJti() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return randomToken(16);
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function toSha256Base64Url(value) {
  return base64UrlEncode(crypto.createHash('sha256').update(String(value || '')).digest());
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isValidPkceVerifier(value) {
  const candidate = String(value || '');
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(candidate);
}

function isValidPkceChallenge(value) {
  const candidate = String(value || '');
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(candidate);
}

function normalizePkceMethod(value) {
  const method = asNonEmptyString(value, 'plain');
  if (SUPPORTED_OAUTH2_PKCE_METHODS.has(method)) {
    return method;
  }
  return '';
}

function isValidRedirectUri(value) {
  try {
    const url = new URL(String(value || ''));
    if (!url.protocol || !url.hostname) {
      return false;
    }
    if (url.hash) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseBasicAuthHeader(headerValue) {
  const header = String(headerValue || '');
  if (!header.toLowerCase().startsWith('basic ')) {
    return null;
  }

  const encoded = header.slice(6).trim();
  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      return null;
    }

    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function readRequestParam(req, key) {
  if (req && req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, key)) {
    const value = req.body[key];
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : '';
    }
    return value === undefined || value === null ? '' : String(value);
  }

  if (req && req.query && typeof req.query === 'object' && Object.prototype.hasOwnProperty.call(req.query, key)) {
    const value = req.query[key];
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : '';
    }
    return value === undefined || value === null ? '' : String(value);
  }

  return '';
}

function buildUrlWithQuery(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function resolveRequestOrigin(req) {
  const protocol = asNonEmptyString(req?.protocol, req?.secure === true ? 'https' : 'http');
  const host = asNonEmptyString(
    typeof req?.get === 'function' ? req.get('host') : req?.headers?.host,
    'localhost',
  );
  return `${protocol}://${host}`;
}

function toOAuthErrorResponse(res, {
  statusCode = 400,
  error = 'invalid_request',
  errorDescription = '',
  wwwAuthenticate = '',
} = {}) {
  if (!res.headersSent && wwwAuthenticate) {
    res.set('WWW-Authenticate', wwwAuthenticate);
  }

  return res.status(statusCode).json({
    error,
    ...(errorDescription ? { error_description: errorDescription } : {}),
  });
}

function createOAuthError(error, errorDescription, statusCode = 400, options = {}) {
  return {
    isOAuthError: true,
    error,
    errorDescription,
    statusCode,
    shouldRedirect: options.shouldRedirect !== false,
    wwwAuthenticate: options.wwwAuthenticate || '',
  };
}

function hashClientSecret(secret) {
  const salt = randomToken(16);
  const derived = crypto.scryptSync(String(secret || ''), salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

async function hashClientSecretAsync(secret) {
  const salt = randomToken(16);
  const derivedBuffer = await scryptAsync(String(secret || ''), salt, 32);
  return `scrypt$${salt}$${Buffer.from(derivedBuffer).toString('hex')}`;
}

function verifyClientSecret(secret, storedHash) {
  const rawHash = String(storedHash || '');
  if (!rawHash) {
    return false;
  }

  if (!rawHash.startsWith('scrypt$')) {
    return constantTimeEqual(secret, rawHash);
  }

  const parts = rawHash.split('$');
  if (parts.length !== 3) {
    return false;
  }

  const salt = parts[1];
  const expected = parts[2];
  const derived = crypto.scryptSync(String(secret || ''), salt, 32).toString('hex');
  return constantTimeEqual(derived, expected);
}

async function verifyClientSecretAsync(secret, storedHash) {
  const rawHash = String(storedHash || '');
  if (!rawHash) {
    return false;
  }

  if (!rawHash.startsWith('scrypt$')) {
    return constantTimeEqual(secret, rawHash);
  }

  const parts = rawHash.split('$');
  if (parts.length !== 3) {
    return false;
  }

  const salt = parts[1];
  const expected = parts[2];
  const derivedBuffer = await scryptAsync(String(secret || ''), salt, 32);
  const derived = Buffer.from(derivedBuffer).toString('hex');
  return constantTimeEqual(derived, expected);
}

function createMemoryStoreAdapter() {
  const fallback = new Map();
  return {
    get: (key) => fallback.get(key),
    set: (key, value) => {
      fallback.set(key, value);
      return value;
    },
    delete: (key) => fallback.delete(key),
  };
}

function createCacheStoreAdapter(cache) {
  if (cache && typeof cache.get === 'function' && typeof cache.set === 'function' && typeof cache.delete === 'function') {
    return {
      get: (key) => cache.get(key),
      set: (key, value) => cache.set(key, value),
      delete: (key) => cache.delete(key),
    };
  }

  return createMemoryStoreAdapter();
}

function createFileStoreAdapter(filePath, rootDir, logger) {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(rootDir || process.cwd(), filePath);
  const directory = path.dirname(resolvedPath);

  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    logger.warn('Auth file store directory setup failed at %s: %s', directory, error?.message || String(error));
    return createMemoryStoreAdapter();
  }

  let snapshot = {};
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        snapshot = parsed;
      }
    } catch (error) {
      logger.warn('Auth file store could not parse %s: %s', resolvedPath, error?.message || String(error));
    }
  }

  const map = new Map(Object.entries(snapshot));
  let writeQueue = Promise.resolve();

  const flush = async () => {
    const payload = JSON.stringify(Object.fromEntries(map), null, 2);
    await fs.promises.writeFile(resolvedPath, `${payload}\n`, 'utf8');
  };

  const enqueueFlush = () => {
    writeQueue = writeQueue
      .then(() => flush())
      .catch((error) => {
        logger.warn('Auth file store write failed at %s: %s', resolvedPath, error?.message || String(error));
      });
    return writeQueue;
  };

  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
      enqueueFlush();
      return value;
    },
    delete: (key) => {
      const deleted = map.delete(key);
      if (deleted) {
        enqueueFlush();
      }
      return deleted;
    },
    ready: Promise.resolve(),
    close: async () => {
      await writeQueue;
    },
  };
}
function isTableExistsError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('already exists')
    || message.includes('exists')
    || message.includes('duplicate')
    || message.includes('is there')
    || message.includes('ora-00955')
    || message.includes('42p07')
    || message.includes('2714')
  );
}

async function ensureSqlStoreTable(client, tableName, logger) {
  if (!client || typeof client.schema !== 'function') {
    return;
  }

  try {
    await client.schema()
      .createTable(tableName, (t) => {
        t.string('id', 191).primary();
        t.text('payload').notNull();
      })
      .exec();
  } catch (error) {
    if (!isTableExistsError(error)) {
      logger.warn('Auth SQL store table setup failed for %s: %s', tableName, error?.message || String(error));
    }
  }
}

function parseSqlPayload(raw, key, logger) {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    logger.warn('Auth SQL store payload parsing failed for key %s: %s', key, error?.message || String(error));
    return undefined;
  }
}

function resolveMongoCollection(database, collectionName) {
  const candidates = [
    database?.mongoose?.connection?.db,
    database?.client?.connection?.db,
    database?.client?.db,
    database?.client,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate.collection === 'function') {
      return candidate.collection(collectionName);
    }
  }

  return null;
}

function createDatabaseStoreAdapter({ config, database, logger }) {
  const map = new Map();
  const storeTableName = config.storage.tableName;
  let backend = 'memory';
  let sqlClient = null;
  let mongoCollection = null;
  let writeQueue = Promise.resolve();

  const loadFromSql = async () => {
    if (!sqlClient || typeof sqlClient.table !== 'function') {
      return;
    }

    const rows = await sqlClient.table(storeTableName).select(['id', 'payload']).get();
    for (const row of rows) {
      const key = asNonEmptyString(row?.id);
      if (!key) {
        continue;
      }

      const payload = parseSqlPayload(row?.payload, key, logger);
      if (payload !== undefined) {
        map.set(key, payload);
      }
    }
  };

  const flushToSql = async () => {
    if (!sqlClient || typeof sqlClient.table !== 'function') {
      return;
    }

    await sqlClient.table(storeTableName).delete().run();
    if (map.size === 0) {
      return;
    }

    const rows = [];
    for (const [id, value] of map.entries()) {
      rows.push({
        id,
        payload: JSON.stringify(value),
      });
    }

    await sqlClient.table(storeTableName).insert(rows).run();
  };

  const upsertSqlEntry = async (key, value) => {
    if (!sqlClient || typeof sqlClient.table !== 'function') {
      return false;
    }

    const table = sqlClient.table(storeTableName);
    if (typeof table.where !== 'function') {
      return false;
    }

    await table.where('id', key).delete().run();
    await sqlClient.table(storeTableName).insert([
      {
        id: key,
        payload: JSON.stringify(value),
      },
    ]).run();
    return true;
  };

  const deleteSqlEntry = async (key) => {
    if (!sqlClient || typeof sqlClient.table !== 'function') {
      return false;
    }

    const table = sqlClient.table(storeTableName);
    if (typeof table.where !== 'function') {
      return false;
    }

    await table.where('id', key).delete().run();
    return true;
  };

  const loadFromMongo = async () => {
    if (!mongoCollection || typeof mongoCollection.find !== 'function') {
      return;
    }

    const docs = await mongoCollection.find({}, { projection: { _id: 1, payload: 1 } }).toArray();
    for (const doc of docs) {
      const key = asNonEmptyString(doc?._id);
      if (!key) {
        continue;
      }
      map.set(key, doc.payload);
    }
  };

  const flushToMongo = async () => {
    if (!mongoCollection || typeof mongoCollection.deleteMany !== 'function') {
      return;
    }

    await mongoCollection.deleteMany({});
    if (map.size === 0 || typeof mongoCollection.insertMany !== 'function') {
      return;
    }

    const docs = [];
    for (const [id, value] of map.entries()) {
      docs.push({
        _id: id,
        payload: value,
      });
    }
    await mongoCollection.insertMany(docs, { ordered: false });
  };

  const upsertMongoEntry = async (key, value) => {
    if (!mongoCollection || typeof mongoCollection.updateOne !== 'function') {
      return false;
    }

    await mongoCollection.updateOne(
      { _id: key },
      { $set: { payload: value } },
      { upsert: true },
    );
    return true;
  };

  const deleteMongoEntry = async (key) => {
    if (!mongoCollection || typeof mongoCollection.deleteOne !== 'function') {
      return false;
    }

    await mongoCollection.deleteOne({ _id: key });
    return true;
  };

  const ready = (async () => {
    if (!database) {
      logger.warn('Auth storage driver "database" selected but database is disabled; using in-memory auth store.');
      return;
    }

    if (database.type === 'sql' && database.client && typeof database.client.table === 'function') {
      sqlClient = database.client;
      await ensureSqlStoreTable(sqlClient, storeTableName, logger);
      await loadFromSql();
      backend = 'sql';
      logger.info('Auth database store ready using SQL table %s (%d records loaded)', storeTableName, map.size);
      return;
    }

    if (database.type === 'nosql') {
      mongoCollection = resolveMongoCollection(database, storeTableName);
      if (mongoCollection) {
        await loadFromMongo();
        backend = 'mongo';
        logger.info('Auth database store ready using Mongo collection %s (%d records loaded)', storeTableName, map.size);
        return;
      }
    }

    logger.warn('Auth storage driver "database" could not use the active database client; using in-memory auth store.');
  })().catch((error) => {
    logger.warn('Auth database store initialization failed: %s', error?.message || String(error));
  });
  writeQueue = ready;

  const persist = async (operation = null) => {
    if (backend === 'sql') {
      if (operation?.type === 'set' && await upsertSqlEntry(operation.key, operation.value)) {
        return;
      }
      if (operation?.type === 'delete' && await deleteSqlEntry(operation.key)) {
        return;
      }
      await flushToSql();
      return;
    }

    if (backend === 'mongo') {
      if (operation?.type === 'set' && await upsertMongoEntry(operation.key, operation.value)) {
        return;
      }
      if (operation?.type === 'delete' && await deleteMongoEntry(operation.key)) {
        return;
      }
      await flushToMongo();
    }
  };

  const enqueuePersist = (operation = null) => {
    writeQueue = writeQueue
      .then(() => persist(operation))
      .catch((error) => {
        logger.warn('Auth database store flush failed: %s', error?.message || String(error));
      });
    return writeQueue;
  };

  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
      enqueuePersist({ type: 'set', key, value });
      return value;
    },
    delete: (key) => {
      const deleted = map.delete(key);
      if (deleted) {
        enqueuePersist({ type: 'delete', key });
      }
      return deleted;
    },
    ready,
    close: async () => {
      await ready;
      await writeQueue;
    },
  };
}
function createStoreAdapter({ config, cache, rootDir, logger, database }) {
  const noopClose = async () => {};

  if (config.storage.driver === 'database') {
    const adapter = createDatabaseStoreAdapter({
      config,
      database,
      logger,
    });
    return {
      adapter,
      ready: adapter.ready || Promise.resolve(),
      close: typeof adapter.close === 'function' ? adapter.close : noopClose,
    };
  }

  if (config.storage.driver === 'memory') {
    return {
      adapter: createMemoryStoreAdapter(),
      ready: Promise.resolve(),
      close: noopClose,
    };
  }

  if (config.storage.driver === 'file') {
    const adapter = createFileStoreAdapter(config.storage.filePath, rootDir, logger);
    return {
      adapter,
      ready: adapter.ready || Promise.resolve(),
      close: typeof adapter.close === 'function' ? adapter.close : noopClose,
    };
  }

  return {
    adapter: createCacheStoreAdapter(cache),
    ready: Promise.resolve(),
    close: noopClose,
  };
}

function createNamespacedStore(adapter, tableName) {
  return {
    key(id) {
      return `${tableName}:${id}`;
    },
    get(id) {
      return adapter.get(`${tableName}:${id}`);
    },
    set(id, value) {
      return adapter.set(`${tableName}:${id}`, value);
    },
    delete(id) {
      return adapter.delete(`${tableName}:${id}`);
    },
  };
}

function extractBearerToken(req) {
  const raw = String(req?.headers?.authorization || '');
  if (!raw.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return raw.slice(7).trim();
}

function createJwtManager({ config, storeAdapter }) {
  if (!config.jwt.secret) {
    throw new Error('Auth provider "jwt" requires auth.jwt.secret (or security.appSecret fallback).');
  }

  const revokedStore = createNamespacedStore(storeAdapter, config.tables.jwtRevocations);

  function isRevoked(jti, nowSeconds = getNowSeconds()) {
    if (!jti) {
      return false;
    }

    const revoked = revokedStore.get(jti);
    if (!revoked) {
      return false;
    }

    if (revoked.expiresAt && Number(revoked.expiresAt) <= nowSeconds) {
      revokedStore.delete(jti);
      return false;
    }

    return true;
  }

  function issueAccessToken({ subject, claims = {}, scope = '', expiresIn } = {}) {
    const sub = asNonEmptyString(subject);
    if (!sub) {
      throw new Error('JWT issueAccessToken requires subject.');
    }

    const payload = {
      ...claims,
      sub,
      scope: normalizeScopes(scope),
      token_type: 'access',
      jti: getJti(),
    };

    return jwt.sign(payload, config.jwt.secret, {
      algorithm: config.jwt.algorithm,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      expiresIn: asNonEmptyString(expiresIn, config.jwt.expiresIn),
    });
  }

  function issueRefreshToken({ subject, claims = {}, scope = '', expiresIn } = {}) {
    const sub = asNonEmptyString(subject);
    if (!sub) {
      throw new Error('JWT issueRefreshToken requires subject.');
    }

    const payload = {
      ...claims,
      sub,
      scope: normalizeScopes(scope),
      token_type: 'refresh',
      jti: getJti(),
    };

    return jwt.sign(payload, config.jwt.secret, {
      algorithm: config.jwt.algorithm,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      expiresIn: asNonEmptyString(expiresIn, config.jwt.refreshExpiresIn),
    });
  }

  function verify(token, options = {}) {
    const decoded = jwt.verify(String(token || ''), config.jwt.secret, {
      algorithms: [config.jwt.algorithm],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      ignoreExpiration: options.ignoreExpiration === true,
    });

    if (decoded && typeof decoded === 'object' && isRevoked(decoded.jti)) {
      throw new Error('Token has been revoked.');
    }

    return decoded;
  }

  function revoke(token) {
    const decoded = jwt.decode(String(token || ''));
    if (!decoded || typeof decoded !== 'object' || !decoded.jti) {
      return false;
    }

    revokedStore.set(decoded.jti, {
      revokedAt: getNowSeconds(),
      expiresAt: Number(decoded.exp) || 0,
    });

    return true;
  }

  function middleware(options = {}) {
    const optional = options.optional === true;

    return (req, res, next) => {
      const token = extractBearerToken(req);
      if (!token) {
        if (optional) {
          return next();
        }
        return res.status(401).json({ error: 'Missing bearer token' });
      }

      try {
        const payload = verify(token);
        req.auth = payload;
        req.user = payload;
        return next();
      } catch (error) {
        if (optional) {
          return next();
        }
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    };
  }

  return {
    enabled: true,
    provider: 'jwt',
    tablePrefix: config.tablePrefix,
    tables: config.tables,
    issue: issueAccessToken,
    issueAccessToken,
    issueRefreshToken,
    verify,
    revoke,
    middleware,
  };
}

function createOAuth2Manager({ config, storeAdapter }) {
  const clientsStore = createNamespacedStore(storeAdapter, config.tables.oauthClients);
  const codeStore = createNamespacedStore(storeAdapter, config.tables.oauthAuthorizationCodes);
  const accessStore = createNamespacedStore(storeAdapter, config.tables.oauthAccessTokens);
  const refreshStore = createNamespacedStore(storeAdapter, config.tables.oauthRefreshTokens);
  const oauthConfig = config.oauth2 || {};
  const serverConfig = oauthConfig.server || {};
  const tokenEndpointPaths = new Set([
    serverConfig.tokenPath,
    serverConfig.introspectionPath,
    serverConfig.revocationPath,
  ].filter(Boolean));
  const oauthServerPaths = new Set([
    serverConfig.authorizePath,
    serverConfig.tokenPath,
    serverConfig.introspectionPath,
    serverConfig.revocationPath,
    serverConfig.metadataPath,
  ].filter(Boolean));

  function deriveClientAllowedScopes(client) {
    if (Array.isArray(client.scopes) && client.scopes.length > 0) {
      return client.scopes;
    }
    return Array.isArray(oauthConfig.defaultScopes) ? oauthConfig.defaultScopes : [];
  }

  function normalizeStoredClient(clientId, client) {
    if (!client || typeof client !== 'object') {
      return null;
    }

    const normalizedId = asNonEmptyString(client.clientId, clientId);
    if (!normalizedId) {
      return null;
    }

    const grants = normalizeOAuth2GrantList(client.grants || oauthConfig.grants);
    const redirectUris = uniqueStrings(
      asStringList(client.redirectUris)
        .filter((uri) => isValidRedirectUri(uri)),
    );
    const scopes = uniqueStrings(asStringList(client.scopes));
    const clientSecretHash = asNonEmptyString(client.clientSecretHash, asNonEmptyString(client.clientSecret, ''));
    const tokenEndpointAuthMethod = normalizeOAuth2ClientAuthMethod(
      client.tokenEndpointAuthMethod,
      oauthConfig.clientAuthMethod || 'client_secret_basic',
    );
    const publicClient = client.publicClient === true || tokenEndpointAuthMethod === 'none';

    return {
      clientId: normalizedId,
      clientSecretHash,
      tokenEndpointAuthMethod,
      publicClient,
      redirectUris,
      grants,
      scopes,
      createdAt: Number(client.createdAt) || getNowSeconds(),
      updatedAt: Number(client.updatedAt) || Number(client.createdAt) || getNowSeconds(),
    };
  }

  function getClient(clientId) {
    const id = asNonEmptyString(clientId);
    if (!id) {
      return null;
    }
    return normalizeStoredClient(id, clientsStore.get(id));
  }

  function sanitizeRegisteredClient(client) {
    if (!client) {
      return null;
    }

    return {
      clientId: client.clientId,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
      publicClient: client.publicClient,
      redirectUris: [...client.redirectUris],
      grants: [...client.grants],
      scopes: [...client.scopes],
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    };
  }

  function assertGrantAllowed(client, grantType) {
    if (!client.grants.includes(grantType)) {
      throw createOAuthError('unauthorized_client', `Client is not allowed to use grant "${grantType}".`, 400, {
        shouldRedirect: false,
      });
    }
  }

  function validateRequestedScope(client, scopeValue) {
    const requestedScope = normalizeScopes(scopeValue);
    const allowedScopes = deriveClientAllowedScopes(client);

    if (!requestedScope) {
      return normalizeScopes(allowedScopes);
    }

    if (allowedScopes.length === 0) {
      return requestedScope;
    }

    const allowed = new Set(allowedScopes);
    const requested = requestedScope.split(/\s+/).filter(Boolean);
    for (const scope of requested) {
      if (!allowed.has(scope)) {
        throw createOAuthError('invalid_scope', `Scope "${scope}" is not allowed for this client.`, 400, {
          shouldRedirect: false,
        });
      }
    }

    return requested.join(' ');
  }

  function resolveClientRedirectUri(client, requestedRedirectUri) {
    const value = asNonEmptyString(requestedRedirectUri);
    const registered = Array.isArray(client.redirectUris) ? client.redirectUris : [];

    if (value) {
      if (!isValidRedirectUri(value)) {
        throw createOAuthError('invalid_request', 'Invalid redirect_uri format.', 400, {
          shouldRedirect: false,
        });
      }
      if (!registered.includes(value)) {
        throw createOAuthError('invalid_request', 'redirect_uri is not registered for this client.', 400, {
          shouldRedirect: false,
        });
      }
      return value;
    }

    if (registered.length === 1) {
      return registered[0];
    }

    throw createOAuthError('invalid_request', 'redirect_uri is required for this client.', 400, {
      shouldRedirect: false,
    });
  }

  function authenticateClientCredentials({
    clientId,
    clientSecret = '',
    allowPublicClient = false,
  } = {}) {
    const id = asNonEmptyString(clientId);
    if (!id) {
      throw createOAuthError('invalid_client', 'Missing client_id.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    const client = getClient(id);
    if (!client) {
      throw createOAuthError('invalid_client', 'Unknown client.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    const secret = asNonEmptyString(clientSecret);
    const authMethod = client.tokenEndpointAuthMethod || oauthConfig.clientAuthMethod || 'client_secret_basic';
    const isPublic = client.publicClient === true || authMethod === 'none';

    if (isPublic) {
      if (!allowPublicClient) {
        throw createOAuthError('invalid_client', 'Public client cannot authenticate on this endpoint.', 401, {
          shouldRedirect: false,
          wwwAuthenticate: 'Basic realm="oauth2"',
        });
      }

      if (secret && !verifyClientSecret(secret, client.clientSecretHash)) {
        throw createOAuthError('invalid_client', 'Invalid client credentials.', 401, {
          shouldRedirect: false,
          wwwAuthenticate: 'Basic realm="oauth2"',
        });
      }

      return client;
    }

    if (!secret) {
      throw createOAuthError('invalid_client', 'Missing client_secret.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    if (!verifyClientSecret(secret, client.clientSecretHash)) {
      throw createOAuthError('invalid_client', 'Invalid client credentials.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    return client;
  }

  function resolveClientFromRequest(req, { allowPublicClient = false } = {}) {
    const basic = parseBasicAuthHeader(req?.headers?.authorization);
    const bodyClientId = asNonEmptyString(readRequestParam(req, 'client_id'));
    const bodyClientSecret = asNonEmptyString(readRequestParam(req, 'client_secret'));
    const clientId = asNonEmptyString(basic?.clientId, bodyClientId);
    const clientSecret = asNonEmptyString(basic?.clientSecret, bodyClientSecret);
    return authenticateClientCredentials({
      clientId,
      clientSecret,
      allowPublicClient,
    });
  }

  async function authenticateClientCredentialsAsync({
    clientId,
    clientSecret = '',
    allowPublicClient = false,
  } = {}) {
    const id = asNonEmptyString(clientId);
    if (!id) {
      throw createOAuthError('invalid_client', 'Missing client_id.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    const client = getClient(id);
    if (!client) {
      throw createOAuthError('invalid_client', 'Unknown client.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    const secret = asNonEmptyString(clientSecret);
    const authMethod = client.tokenEndpointAuthMethod || oauthConfig.clientAuthMethod || 'client_secret_basic';
    const isPublic = client.publicClient === true || authMethod === 'none';

    if (isPublic) {
      if (!allowPublicClient) {
        throw createOAuthError('invalid_client', 'Public client cannot authenticate on this endpoint.', 401, {
          shouldRedirect: false,
          wwwAuthenticate: 'Basic realm="oauth2"',
        });
      }

      if (secret && !await verifyClientSecretAsync(secret, client.clientSecretHash)) {
        throw createOAuthError('invalid_client', 'Invalid client credentials.', 401, {
          shouldRedirect: false,
          wwwAuthenticate: 'Basic realm="oauth2"',
        });
      }

      return client;
    }

    if (!secret) {
      throw createOAuthError('invalid_client', 'Missing client_secret.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    if (!await verifyClientSecretAsync(secret, client.clientSecretHash)) {
      throw createOAuthError('invalid_client', 'Invalid client credentials.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }

    return client;
  }

  async function resolveClientFromRequestAsync(req, { allowPublicClient = false } = {}) {
    const basic = parseBasicAuthHeader(req?.headers?.authorization);
    const bodyClientId = asNonEmptyString(readRequestParam(req, 'client_id'));
    const bodyClientSecret = asNonEmptyString(readRequestParam(req, 'client_secret'));
    const clientId = asNonEmptyString(basic?.clientId, bodyClientId);
    const clientSecret = asNonEmptyString(basic?.clientSecret, bodyClientSecret);
    return authenticateClientCredentialsAsync({
      clientId,
      clientSecret,
      allowPublicClient,
    });
  }

  function issueTokens({
    client,
    subject = '',
    scope = '',
    grantType = 'client_credentials',
    includeRefreshToken = true,
  } = {}) {
    const now = getNowSeconds();
    const resolvedScope = validateRequestedScope(client, scope);
    const accessToken = randomToken(32);
    const accessExpiresAt = now + oauthConfig.accessTokenTtlSeconds;
    const accessRecord = {
      tokenType: 'Bearer',
      grantType,
      clientId: client.clientId,
      sub: asNonEmptyString(subject),
      scope: resolvedScope,
      issuedAt: now,
      expiresAt: accessExpiresAt,
    };
    accessStore.set(hashToken(accessToken), accessRecord);

    let refreshToken = '';
    if (includeRefreshToken && client.grants.includes('refresh_token')) {
      refreshToken = randomToken(48);
      const refreshExpiresAt = now + oauthConfig.refreshTokenTtlSeconds;
      const refreshRecord = {
        tokenType: 'refresh_token',
        grantType,
        clientId: client.clientId,
        sub: asNonEmptyString(subject),
        scope: resolvedScope,
        issuedAt: now,
        expiresAt: refreshExpiresAt,
      };
      refreshStore.set(hashToken(refreshToken), refreshRecord);
    }

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: oauthConfig.accessTokenTtlSeconds,
      scope: resolvedScope,
      ...(refreshToken
        ? {
            refreshToken,
            refreshExpiresIn: oauthConfig.refreshTokenTtlSeconds,
          }
        : {}),
    };
  }

  function getAccessTokenRecord(token) {
    const hashed = hashToken(token);
    const access = accessStore.get(hashed);
    if (!access) {
      return null;
    }

    const now = getNowSeconds();
    if (Number(access.expiresAt) <= now) {
      accessStore.delete(hashed);
      return null;
    }

    return access;
  }

  function getRefreshTokenRecord(token) {
    const hashed = hashToken(token);
    const refresh = refreshStore.get(hashed);
    if (!refresh) {
      return null;
    }

    const now = getNowSeconds();
    if (Number(refresh.expiresAt) <= now) {
      refreshStore.delete(hashed);
      return null;
    }

    return refresh;
  }

  function getAuthorizationCodeRecord(code) {
    const hashed = hashToken(code);
    const record = codeStore.get(hashed);
    if (!record) {
      return null;
    }

    const now = getNowSeconds();
    if (Number(record.expiresAt) <= now) {
      codeStore.delete(hashed);
      return null;
    }

    return record;
  }

  function registerClient({
    clientId,
    clientSecret = '',
    redirectUris = [],
    grants = [],
    scopes = [],
    publicClient = false,
    tokenEndpointAuthMethod = '',
  } = {}) {
    const normalizedId = asNonEmptyString(clientId);
    if (!normalizedId) {
      throw new Error('registerClient requires clientId.');
    }

    const normalizedRedirectUris = uniqueStrings(
      asStringList(redirectUris)
        .filter((uri) => isValidRedirectUri(uri)),
    );
    const defaultGrants = normalizedRedirectUris.length > 0
      ? oauthConfig.grants
      : (oauthConfig.grants || []).filter((grant) => grant !== 'authorization_code');
    const normalizedGrants = normalizeOAuth2GrantList(grants.length > 0 ? grants : defaultGrants);
    const normalizedScopes = normalizeOAuth2Scopes(scopes);
    const normalizedSecret = asNonEmptyString(clientSecret);
    const authMethod = normalizeOAuth2ClientAuthMethod(
      tokenEndpointAuthMethod,
      publicClient === true ? 'none' : oauthConfig.clientAuthMethod,
    );
    const isPublicClient = publicClient === true || authMethod === 'none';

    if (normalizedGrants.includes('authorization_code') && normalizedRedirectUris.length === 0) {
      throw new Error('registerClient requires at least one redirect URI for authorization_code grant.');
    }

    if (!isPublicClient && oauthConfig.requireClientSecret && !normalizedSecret) {
      throw new Error('registerClient requires clientSecret for confidential clients.');
    }

    const now = getNowSeconds();
    const existing = getClient(normalizedId);
    const storedClient = {
      clientId: normalizedId,
      clientSecretHash: normalizedSecret
        ? hashClientSecret(normalizedSecret)
        : (existing?.clientSecretHash || ''),
      tokenEndpointAuthMethod: isPublicClient ? 'none' : authMethod,
      publicClient: isPublicClient,
      redirectUris: normalizedRedirectUris,
      grants: normalizedGrants,
      scopes: normalizedScopes,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    clientsStore.set(normalizedId, storedClient);
    return sanitizeRegisteredClient(storedClient);
  }

  function createAuthorizationCode({
    clientId,
    redirectUri,
    subject,
    scope = '',
    codeChallenge = '',
    codeChallengeMethod = 'plain',
    nonce = '',
  } = {}) {
    const client = getClient(clientId);
    if (!client) {
      throw createOAuthError('invalid_client', 'Unknown client.', 400);
    }
    assertGrantAllowed(client, 'authorization_code');

    const resolvedRedirectUri = resolveClientRedirectUri(client, redirectUri);
    const sub = asNonEmptyString(subject);
    if (!sub) {
      throw createOAuthError('access_denied', 'Authenticated subject is required.', 401);
    }

    const requestedCodeChallenge = asNonEmptyString(codeChallenge);
    const resolvedMethod = normalizePkceMethod(codeChallengeMethod || 'plain');

    if (oauthConfig.requirePkce && !requestedCodeChallenge) {
      throw createOAuthError('invalid_request', 'PKCE code_challenge is required.');
    }

    if (requestedCodeChallenge) {
      if (!isValidPkceChallenge(requestedCodeChallenge)) {
        throw createOAuthError('invalid_request', 'Invalid PKCE code_challenge.');
      }

      if (!resolvedMethod) {
        throw createOAuthError('invalid_request', 'Unsupported code_challenge_method.');
      }

      if (resolvedMethod === 'plain' && !oauthConfig.allowPlainPkce) {
        throw createOAuthError('invalid_request', 'PKCE plain challenge is disabled.');
      }
    }

    const now = getNowSeconds();
    const code = randomToken(32);
    const expiresAt = now + oauthConfig.authorizationCodeTtlSeconds;
    const normalizedScope = validateRequestedScope(client, scope);
    const record = {
      clientId: client.clientId,
      redirectUri: resolvedRedirectUri,
      sub,
      scope: normalizedScope,
      codeChallenge: requestedCodeChallenge,
      codeChallengeMethod: resolvedMethod || 'plain',
      nonce: asNonEmptyString(nonce),
      issuedAt: now,
      expiresAt,
    };
    codeStore.set(hashToken(code), record);
    return {
      code,
      expiresIn: oauthConfig.authorizationCodeTtlSeconds,
      redirectUri: resolvedRedirectUri,
      scope: normalizedScope,
    };
  }

  function exchangeAuthorizationCode({
    code,
    client,
    redirectUri,
    codeVerifier = '',
  } = {}) {
    const normalizedCode = asNonEmptyString(code);
    if (!normalizedCode) {
      throw createOAuthError('invalid_request', 'Missing authorization code.');
    }

    const resolvedClient = client;
    if (!resolvedClient) {
      throw createOAuthError('invalid_client', 'Client authentication failed.', 401, {
        shouldRedirect: false,
        wwwAuthenticate: 'Basic realm="oauth2"',
      });
    }
    assertGrantAllowed(resolvedClient, 'authorization_code');

    const codeHash = hashToken(normalizedCode);
    const record = codeStore.get(codeHash);
    if (!record) {
      throw createOAuthError('invalid_grant', 'Authorization code is invalid.');
    }

    const now = getNowSeconds();
    if (Number(record.expiresAt) <= now) {
      codeStore.delete(codeHash);
      throw createOAuthError('invalid_grant', 'Authorization code is expired.');
    }

    if (record.clientId !== resolvedClient.clientId) {
      throw createOAuthError('invalid_grant', 'Authorization code does not belong to this client.');
    }

    const resolvedRedirectUri = resolveClientRedirectUri(resolvedClient, redirectUri);
    if (!constantTimeEqual(resolvedRedirectUri, record.redirectUri)) {
      throw createOAuthError('invalid_grant', 'redirect_uri mismatch.');
    }

    if (record.codeChallenge) {
      const verifier = asNonEmptyString(codeVerifier);
      if (!isValidPkceVerifier(verifier)) {
        throw createOAuthError('invalid_grant', 'Invalid or missing code_verifier.');
      }

      if (record.codeChallengeMethod === 'S256') {
        if (!constantTimeEqual(toSha256Base64Url(verifier), record.codeChallenge)) {
          throw createOAuthError('invalid_grant', 'PKCE verification failed.');
        }
      } else if (!constantTimeEqual(verifier, record.codeChallenge)) {
        throw createOAuthError('invalid_grant', 'PKCE verification failed.');
      }
    } else if (oauthConfig.requirePkce) {
      throw createOAuthError('invalid_grant', 'Authorization code is missing PKCE challenge.');
    }

    codeStore.delete(codeHash);
    return issueTokens({
      client: resolvedClient,
      subject: record.sub,
      scope: record.scope,
      grantType: 'authorization_code',
      includeRefreshToken: true,
    });
  }

  function issue({ clientId, clientSecret = '', subject = '', scope = '' } = {}) {
    const client = authenticateClientCredentials({
      clientId,
      clientSecret,
      allowPublicClient: true,
    });
    const grantType = client.grants.includes('authorization_code') ? 'authorization_code' : 'client_credentials';
    return issueTokens({
      client,
      subject,
      scope,
      grantType,
      includeRefreshToken: true,
    });
  }

  function issueClientCredentialsForClient(client, scope = '') {
    assertGrantAllowed(client, 'client_credentials');
    return issueTokens({
      client,
      subject: '',
      scope,
      grantType: 'client_credentials',
      includeRefreshToken: false,
    });
  }

  function issueClientCredentials({ clientId, clientSecret = '', scope = '' } = {}) {
    const client = authenticateClientCredentials({
      clientId,
      clientSecret,
      allowPublicClient: false,
    });
    return issueClientCredentialsForClient(client, scope);
  }

  function introspect(token) {
    const access = getAccessTokenRecord(token);
    if (access) {
      return {
        active: true,
        clientId: access.clientId,
        sub: access.sub,
        scope: access.scope,
        iat: access.issuedAt,
        exp: access.expiresAt,
        tokenType: 'Bearer',
        grantType: access.grantType,
      };
    }

    const refresh = getRefreshTokenRecord(token);
    if (refresh) {
      return {
        active: true,
        clientId: refresh.clientId,
        sub: refresh.sub,
        scope: refresh.scope,
        iat: refresh.issuedAt,
        exp: refresh.expiresAt,
        tokenType: 'refresh_token',
        grantType: refresh.grantType,
      };
    }

    const code = getAuthorizationCodeRecord(token);
    if (code) {
      return {
        active: true,
        clientId: code.clientId,
        sub: code.sub,
        scope: code.scope,
        iat: code.issuedAt,
        exp: code.expiresAt,
        tokenType: 'authorization_code',
        grantType: 'authorization_code',
      };
    }

    return { active: false };
  }

  function introspectForEndpoint(token) {
    const info = introspect(token);
    if (!info.active) {
      return { active: false };
    }

    return {
      active: true,
      scope: info.scope || '',
      client_id: info.clientId,
      username: info.sub || undefined,
      sub: info.sub || undefined,
      token_type: info.tokenType || 'Bearer',
      exp: info.exp,
      iat: info.iat,
      iss: serverConfig.issuer || undefined,
      grant_type: info.grantType || undefined,
    };
  }

  function revoke(token, options = {}) {
    const normalized = asNonEmptyString(token);
    if (!normalized) {
      return false;
    }

    const clientId = asNonEmptyString(options.clientId);
    const hashed = hashToken(normalized);
    const access = accessStore.get(hashed);
    const refresh = refreshStore.get(hashed);
    const code = codeStore.get(hashed);
    let removed = false;

    if (access && (!clientId || access.clientId === clientId)) {
      removed = accessStore.delete(hashed) || removed;
    }

    if (refresh && (!clientId || refresh.clientId === clientId)) {
      removed = refreshStore.delete(hashed) || removed;
    }

    if (code && (!clientId || code.clientId === clientId)) {
      removed = codeStore.delete(hashed) || removed;
    }

    return removed;
  }

  function exchangeRefreshTokenForClient({
    refreshToken,
    client,
    scope = '',
  } = {}) {
    assertGrantAllowed(client, 'refresh_token');

    const normalizedRefreshToken = asNonEmptyString(refreshToken);
    if (!normalizedRefreshToken) {
      throw new Error('Invalid refresh token.');
    }

    const hashed = hashToken(normalizedRefreshToken);
    const refreshRecord = refreshStore.get(hashed);
    if (!refreshRecord) {
      throw new Error('Invalid refresh token.');
    }

    const now = getNowSeconds();
    if (Number(refreshRecord.expiresAt) <= now) {
      refreshStore.delete(hashed);
      throw new Error('Expired refresh token.');
    }

    if (refreshRecord.clientId !== client.clientId) {
      throw new Error('Refresh token does not belong to the provided client.');
    }

    if (oauthConfig.rotateRefreshToken) {
      refreshStore.delete(hashed);
    }

    const requestedScope = normalizeScopes(scope) || refreshRecord.scope;
    return issueTokens({
      client,
      subject: refreshRecord.sub,
      scope: requestedScope,
      grantType: 'refresh_token',
      includeRefreshToken: true,
    });
  }

  function exchangeRefreshToken({
    refreshToken,
    clientId,
    clientSecret = '',
    scope = '',
  } = {}) {
    const client = authenticateClientCredentials({
      clientId,
      clientSecret,
      allowPublicClient: true,
    });
    return exchangeRefreshTokenForClient({
      refreshToken,
      client,
      scope,
    });
  }

  function middleware(options = {}) {
    const optional = options.optional === true;

    return (req, res, next) => {
      const token = extractBearerToken(req);
      if (!token) {
        if (optional) {
          return next();
        }
        return res.status(401).json({ error: 'Missing bearer token' });
      }

      const tokenInfo = introspect(token);
      if (!tokenInfo.active || tokenInfo.tokenType !== 'Bearer') {
        if (optional) {
          return next();
        }
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      req.auth = tokenInfo;
      req.user = tokenInfo.sub ? { id: tokenInfo.sub } : null;
      return next();
    };
  }

  async function resolveAuthorizationSubject(req, params, client) {
    if (typeof serverConfig.resolveSubject === 'function') {
      const resolved = await serverConfig.resolveSubject({ req, params, client });
      return asNonEmptyString(resolved);
    }

    const fromReqUser = asNonEmptyString(req?.user?.id, asNonEmptyString(req?.user?.sub));
    const fromReqAuth = asNonEmptyString(req?.auth?.sub);

    if (fromReqUser || fromReqAuth) {
      return fromReqUser || fromReqAuth;
    }

    if (serverConfig.allowSubjectFromParams === true) {
      return asNonEmptyString(params.subject, asNonEmptyString(params.user_id));
    }

    return '';
  }

  async function isConsentApproved(req, params, client, subject) {
    if (typeof serverConfig.resolveConsent === 'function') {
      const approved = await serverConfig.resolveConsent({
        req,
        params,
        client,
        subject,
      });
      return approved === true;
    }

    if (serverConfig.requireConsent === true) {
      const approveValue = asNonEmptyString(readRequestParam(req, 'approve')).toLowerCase();
      return approveValue === '1' || approveValue === 'true' || approveValue === 'yes';
    }

    return serverConfig.autoApprove !== false;
  }

  function shouldRejectInsecureTransport(req) {
    if (serverConfig.allowHttp === true) {
      return false;
    }

    return req?.secure !== true;
  }

  function ensureSecureTransport(req) {
    if (shouldRejectInsecureTransport(req)) {
      throw createOAuthError('invalid_request', 'OAuth2 endpoints require HTTPS.', 400, {
        shouldRedirect: false,
      });
    }
  }

  function resolveAuthorizeParams(req) {
    return {
      response_type: asNonEmptyString(readRequestParam(req, 'response_type')).toLowerCase(),
      client_id: asNonEmptyString(readRequestParam(req, 'client_id')),
      redirect_uri: asNonEmptyString(readRequestParam(req, 'redirect_uri')),
      scope: normalizeScopes(readRequestParam(req, 'scope')),
      state: asNonEmptyString(readRequestParam(req, 'state')),
      code_challenge: asNonEmptyString(readRequestParam(req, 'code_challenge')),
      code_challenge_method: asNonEmptyString(readRequestParam(req, 'code_challenge_method'), 'plain'),
      nonce: asNonEmptyString(readRequestParam(req, 'nonce')),
      subject: asNonEmptyString(readRequestParam(req, 'subject')),
      user_id: asNonEmptyString(readRequestParam(req, 'user_id')),
    };
  }

  async function authorizeEndpoint(req, res) {
    const params = resolveAuthorizeParams(req);
    let redirectUri = '';
    let state = '';

    try {
      ensureSecureTransport(req);

      if (params.response_type !== 'code') {
        throw createOAuthError('unsupported_response_type', 'Only response_type=code is supported.');
      }

      if (!params.client_id) {
        throw createOAuthError('invalid_request', 'Missing client_id.', 400, {
          shouldRedirect: false,
        });
      }

      const client = getClient(params.client_id);
      if (!client) {
        throw createOAuthError('invalid_client', 'Unknown client.', 400, {
          shouldRedirect: false,
        });
      }

      assertGrantAllowed(client, 'authorization_code');
      redirectUri = resolveClientRedirectUri(client, params.redirect_uri);
      state = params.state;

      const subject = await resolveAuthorizationSubject(req, params, client);
      if (!subject && serverConfig.requireAuthenticatedUser !== false) {
        throw createOAuthError('access_denied', 'Authenticated user is required.', 401);
      }

      const consentApproved = await isConsentApproved(req, params, client, subject);
      if (!consentApproved) {
        throw createOAuthError('access_denied', 'Resource owner denied the authorization request.');
      }

      const issued = createAuthorizationCode({
        clientId: client.clientId,
        redirectUri,
        subject,
        scope: params.scope,
        codeChallenge: params.code_challenge,
        codeChallengeMethod: params.code_challenge_method,
        nonce: params.nonce,
      });

      return res.redirect(302, buildUrlWithQuery(redirectUri, {
        code: issued.code,
        state: state || undefined,
      }));
    } catch (error) {
      if (redirectUri && error?.shouldRedirect !== false) {
        return res.redirect(302, buildUrlWithQuery(redirectUri, {
          error: error?.error || 'server_error',
          error_description: error?.errorDescription || 'Authorization failed.',
          state: state || undefined,
        }));
      }

      if (error?.isOAuthError) {
        return toOAuthErrorResponse(res, {
          statusCode: error.statusCode || 400,
          error: error.error,
          errorDescription: error.errorDescription,
          wwwAuthenticate: error.wwwAuthenticate,
        });
      }

      return toOAuthErrorResponse(res, {
        statusCode: 500,
        error: 'server_error',
        errorDescription: error?.message || 'Authorization server error.',
      });
    }
  }

  function toTokenEndpointPayload(tokens) {
    return {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType || 'Bearer',
      expires_in: tokens.expiresIn,
      scope: tokens.scope || '',
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
      ...(tokens.refreshExpiresIn ? { refresh_expires_in: tokens.refreshExpiresIn } : {}),
    };
  }

  async function tokenEndpoint(req, res) {
    try {
      ensureSecureTransport(req);
      const grantType = asNonEmptyString(readRequestParam(req, 'grant_type')).toLowerCase();
      if (!grantType) {
        throw createOAuthError('invalid_request', 'Missing grant_type.');
      }

      if (!SUPPORTED_OAUTH2_GRANTS.has(grantType)) {
        throw createOAuthError('unsupported_grant_type', `Unsupported grant_type "${grantType}".`);
      }

      let tokens;
      if (grantType === 'authorization_code') {
        const client = await resolveClientFromRequestAsync(req, { allowPublicClient: true });
        assertGrantAllowed(client, 'authorization_code');
        tokens = exchangeAuthorizationCode({
          code: readRequestParam(req, 'code'),
          client,
          redirectUri: readRequestParam(req, 'redirect_uri'),
          codeVerifier: readRequestParam(req, 'code_verifier'),
        });
      } else if (grantType === 'refresh_token') {
        const client = await resolveClientFromRequestAsync(req, { allowPublicClient: true });
        assertGrantAllowed(client, 'refresh_token');
        tokens = exchangeRefreshTokenForClient({
          refreshToken: readRequestParam(req, 'refresh_token'),
          client,
          scope: readRequestParam(req, 'scope'),
        });
      } else {
        const client = await resolveClientFromRequestAsync(req, { allowPublicClient: false });
        tokens = issueClientCredentialsForClient(client, readRequestParam(req, 'scope'));
      }

      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      return res.json(toTokenEndpointPayload(tokens));
    } catch (error) {
      if (error?.isOAuthError) {
        return toOAuthErrorResponse(res, {
          statusCode: error.statusCode || 400,
          error: error.error,
          errorDescription: error.errorDescription,
          wwwAuthenticate: error.wwwAuthenticate,
        });
      }

      return toOAuthErrorResponse(res, {
        statusCode: 400,
        error: 'invalid_grant',
        errorDescription: error?.message || 'Token issuance failed.',
      });
    }
  }

  async function introspectionEndpoint(req, res) {
    try {
      ensureSecureTransport(req);
      await resolveClientFromRequestAsync(req, { allowPublicClient: false });
      const token = asNonEmptyString(readRequestParam(req, 'token'));
      if (!token) {
        throw createOAuthError('invalid_request', 'Missing token.');
      }

      const payload = introspectForEndpoint(token);
      return res.json(payload);
    } catch (error) {
      if (error?.isOAuthError) {
        return toOAuthErrorResponse(res, {
          statusCode: error.statusCode || 400,
          error: error.error,
          errorDescription: error.errorDescription,
          wwwAuthenticate: error.wwwAuthenticate,
        });
      }

      return toOAuthErrorResponse(res, {
        statusCode: 400,
        error: 'invalid_request',
        errorDescription: error?.message || 'Token introspection failed.',
      });
    }
  }

  async function revocationEndpoint(req, res) {
    try {
      ensureSecureTransport(req);
      const client = await resolveClientFromRequestAsync(req, { allowPublicClient: false });
      const token = asNonEmptyString(readRequestParam(req, 'token'));
      if (!token) {
        throw createOAuthError('invalid_request', 'Missing token.');
      }

      revoke(token, { clientId: client.clientId });
      return res.status(200).end();
    } catch (error) {
      if (error?.isOAuthError) {
        return toOAuthErrorResponse(res, {
          statusCode: error.statusCode || 400,
          error: error.error,
          errorDescription: error.errorDescription,
          wwwAuthenticate: error.wwwAuthenticate,
        });
      }

      return toOAuthErrorResponse(res, {
        statusCode: 400,
        error: 'invalid_request',
        errorDescription: error?.message || 'Token revocation failed.',
      });
    }
  }

  function metadataEndpoint(req, res) {
    const origin = resolveRequestOrigin(req);
    const issuer = asNonEmptyString(serverConfig.issuer, origin);
    const endpointUrl = (value) => {
      if (String(value).startsWith('http://') || String(value).startsWith('https://')) {
        return String(value);
      }
      return `${origin}${value}`;
    };

    return res.json({
      issuer,
      authorization_endpoint: endpointUrl(serverConfig.authorizePath),
      token_endpoint: endpointUrl(serverConfig.tokenPath),
      introspection_endpoint: endpointUrl(serverConfig.introspectionPath),
      revocation_endpoint: endpointUrl(serverConfig.revocationPath),
      response_types_supported: ['code'],
      grant_types_supported: [...SUPPORTED_OAUTH2_GRANTS],
      token_endpoint_auth_methods_supported: [...SUPPORTED_OAUTH2_CLIENT_AUTH_METHODS],
      code_challenge_methods_supported: oauthConfig.allowPlainPkce ? ['S256', 'plain'] : ['S256'],
      scopes_supported: oauthConfig.defaultScopes,
    });
  }

  function isOAuthServerRequestPath(requestPath) {
    return oauthServerPaths.has(String(requestPath || ''));
  }

  return {
    enabled: true,
    provider: 'oauth2',
    tablePrefix: config.tablePrefix,
    tables: config.tables,
    registerClient,
    issue,
    issueClientCredentials,
    createAuthorizationCode,
    exchangeAuthorizationCode,
    introspect,
    revoke,
    exchangeRefreshToken,
    middleware,
    isOAuthServerRequestPath,
    oauth2Server: {
      enabled: serverConfig.enabled === true,
      paths: {
        basePath: serverConfig.basePath,
        authorize: serverConfig.authorizePath,
        token: serverConfig.tokenPath,
        introspect: serverConfig.introspectionPath,
        revoke: serverConfig.revocationPath,
        metadata: serverConfig.metadataPath,
      },
      handlers: {
        authorize: authorizeEndpoint,
        token: tokenEndpoint,
        introspect: introspectionEndpoint,
        revoke: revocationEndpoint,
        metadata: metadataEndpoint,
      },
      isTokenEndpointPath: (requestPath) => tokenEndpointPaths.has(String(requestPath || '')),
    },
  };
}

function createAuthDisabledError(actionName) {
  const error = new Error(`Auth is disabled. Cannot execute "${actionName}".`);
  error.code = 'AUTH_DISABLED';
  error.statusCode = 503;
  return error;
}

function createDisabledAuthManager(config) {
  const safeConfig = isPlainObject(config)
    ? config
    : {
        provider: 'jwt',
        tablePrefix: 'aegisnode',
        tables: buildAuthTables('aegisnode'),
      };
  const fail = (actionName) => {
    throw createAuthDisabledError(actionName);
  };

  const middleware = (options = {}) => {
    const optional = options.optional === true;
    return (req, res, next) => {
      if (optional) {
        return next();
      }
      return res.status(503).json({ error: 'Auth is disabled' });
    };
  };

  return {
    enabled: false,
    provider: safeConfig.provider,
    tablePrefix: safeConfig.tablePrefix,
    tables: safeConfig.tables,
    ready: Promise.resolve(),
    close: async () => {},
    middleware,
    guard: middleware,
    issue: () => fail('issue'),
    issueAccessToken: () => fail('issueAccessToken'),
    issueRefreshToken: () => fail('issueRefreshToken'),
    verify: () => fail('verify'),
    revoke: () => fail('revoke'),
    registerClient: () => fail('registerClient'),
    createAuthorizationCode: () => fail('createAuthorizationCode'),
    exchangeAuthorizationCode: () => fail('exchangeAuthorizationCode'),
    introspect: () => fail('introspect'),
    exchangeRefreshToken: () => fail('exchangeRefreshToken'),
    issueClientCredentials: () => fail('issueClientCredentials'),
    isOAuthServerRequestPath: () => false,
    oauth2Server: {
      enabled: false,
      paths: {},
      handlers: {},
      isTokenEndpointPath: () => false,
    },
  };
}

export function createAuthGuard(auth, options = {}) {
  if (auth && typeof auth.middleware === 'function') {
    return auth.middleware(options);
  }

  const optional = options.optional === true;
  return (req, res, next) => {
    if (optional) {
      return next();
    }
    return res.status(503).json({ error: 'Auth is disabled' });
  };
}

export function normalizeAuthConfig(rawAuth, { appName = 'aegisnode', appSecret = '' } = {}) {
  const auth = isPlainObject(rawAuth) ? rawAuth : {};
  const providerCandidate = String(auth.provider || 'jwt').toLowerCase();
  const provider = SUPPORTED_PROVIDERS.has(providerCandidate) ? providerCandidate : 'jwt';
  const tablePrefix = sanitizeTablePrefix(auth.tablePrefix, 'aegisnode');

  return {
    enabled: auth.enabled === true,
    provider,
    tablePrefix,
    tables: buildAuthTables(tablePrefix),
    storage: normalizeAuthStorageConfig(auth.storage, tablePrefix),
    jwt: normalizeJwtConfig(auth.jwt, appName, appSecret),
    oauth2: normalizeOAuth2Config(auth.oauth2, appName),
  };
}

export function createAuthManager({ config, cache, logger, rootDir, database }) {
  if (!config?.enabled) {
    logger.debug('Auth subsystem disabled by configuration.');
    return createDisabledAuthManager(config);
  }

  const { adapter: storeAdapter, ready, close } = createStoreAdapter({
    config,
    cache,
    rootDir,
    logger,
    database,
  });
  const manager = config.provider === 'oauth2'
    ? createOAuth2Manager({ config, storeAdapter })
    : createJwtManager({ config, storeAdapter });

  manager.guard = manager.middleware;
  manager.ready = ready || Promise.resolve();
  manager.close = typeof close === 'function' ? close : async () => {};
  logger.info('Auth subsystem enabled with provider %s (table prefix: %s)', manager.provider, manager.tablePrefix);
  return manager;
}

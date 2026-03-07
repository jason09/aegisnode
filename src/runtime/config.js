import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeEnvironmentName(value, fallback = 'development') {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function applyEnvironmentOverrides(config, logger = null) {
  if (!isPlainObject(config)) {
    return config;
  }

  const targetEnv = normalizeEnvironmentName(
    config.env,
    normalizeEnvironmentName(process.env.NODE_ENV, 'development'),
  );
  const environments = isPlainObject(config.environments) ? config.environments : {};
  const defaultOverride = environments.default;
  const envOverride = environments[targetEnv];

  let merged = {
    ...config,
    env: targetEnv,
  };

  if (isPlainObject(defaultOverride)) {
    merged = deepMerge(merged, defaultOverride);
  }

  if (isPlainObject(envOverride)) {
    merged = deepMerge(merged, envOverride);
  }

  merged.env = targetEnv;

  if (logger && (isPlainObject(defaultOverride) || isPlainObject(envOverride))) {
    logger.debug('Environment overrides applied for env "%s"', targetEnv);
  }

  return merged;
}

export function deepMerge(base, extension) {
  if (!isPlainObject(base) || !isPlainObject(extension)) {
    return extension;
  }

  const merged = { ...base };
  for (const key of Object.keys(extension)) {
    const left = merged[key];
    const right = extension[key];

    if (Array.isArray(left) && Array.isArray(right)) {
      merged[key] = [...right];
      continue;
    }

    if (isPlainObject(left) && isPlainObject(right)) {
      merged[key] = deepMerge(left, right);
      continue;
    }

    merged[key] = right;
  }

  return merged;
}

export function normalizeAppEntry(entry) {
  if (typeof entry === 'string') {
    return {
      name: entry,
      mount: `/${entry}`,
    };
  }

  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
    throw new Error(`Invalid app entry in settings. Expected string or { name, mount } object, got: ${JSON.stringify(entry)}`);
  }

  const mount = entry.mount ? String(entry.mount) : `/${entry.name}`;

  return {
    name: entry.name,
    mount: mount === '/' ? '/' : `/${mount.replace(/^\/+/, '').replace(/\/+$/, '')}`,
  };
}

export function normalizeApps(apps) {
  if (!Array.isArray(apps)) {
    return [];
  }
  return apps.map(normalizeAppEntry);
}

export function defaultConfig(rootDir) {
  const appName = path.basename(rootDir);

  return {
    appName,
    env: process.env.NODE_ENV || 'development',
    host: process.env.HOST || '0.0.0.0',
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    rootDir,
    staticDir: null,
    templates: {
      enabled: true,
      engine: 'ejs',
      dir: 'templates',
      base: 'base',
    },
    i18n: {
      enabled: false,
      defaultLocale: 'en',
      fallbackLocale: 'en',
      supported: ['en'],
      queryParam: 'lang',
      cookieName: 'aegis_locale',
      detectFromHeader: true,
      detectFromCookie: true,
      detectFromQuery: true,
      translations: {},
    },
    helpers: {
      locale: 'en-US',
      money: {
        currency: 'USD',
      },
    },
    security: {
      appSecret: '',
      headers: {
        enabled: true,
        csp: {
          enabled: true,
          reportOnly: false,
          directives: {},
        },
      },
      ddos: {
        enabled: true,
        windowMs: 60000,
        maxRequests: 120,
        message: 'Too many requests, please try again later.',
        statusCode: 429,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: false,
        skipFailedRequests: false,
        trustProxy: false,
        skipPaths: ['/health'],
      },
      csrf: {
        enabled: true,
        rejectForms: true,
        rejectUnsafeMethods: true,
        cookieName: '_aegis_csrf',
        fieldName: '_csrf',
        headerName: 'x-csrf-token',
        requireSignedCookie: true,
        sameSite: 'lax',
        secure: 'auto',
        httpOnly: true,
        path: '/',
      },
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
    database: {
      enabled: false,
      dialect: 'pg',
      config: {},
      options: {},
    },
    cache: {
      enabled: true,
      driver: 'memory',
      options: {},
    },
    websocket: {
      enabled: true,
      cors: {
        origin: false,
      },
    },
    uploads: {
      enabled: true,
      dir: 'uploads',
      createDir: true,
      preserveExtension: true,
      maxFileSize: 5 * 1024 * 1024,
      maxFiles: 5,
      maxFields: 50,
      maxFieldSize: 1024 * 1024,
      allowedMimeTypes: [],
      allowedExtensions: [],
      allowApiMultipart: true,
    },
    api: {
      apps: [],
      disableCsrf: true,
      requireJsonForUnsafeMethods: true,
      noStoreHeaders: true,
    },
    auth: {
      enabled: false,
      provider: 'jwt',
      tablePrefix: 'aegisnode',
      storage: {
        driver: 'cache',
        filePath: 'storage/aegisnode-auth-store.json',
        tableName: 'aegisnode_auth_store',
      },
      jwt: {
        secret: '',
        algorithm: 'HS256',
        expiresIn: '15m',
        refreshExpiresIn: '7d',
        issuer: appName,
        audience: appName,
      },
      oauth2: {
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 1209600,
        authorizationCodeTtlSeconds: 600,
        rotateRefreshToken: true,
        requireClientSecret: true,
        requirePkce: true,
        allowPlainPkce: false,
        grants: ['authorization_code', 'refresh_token', 'client_credentials'],
        defaultScopes: [],
        clientAuthMethod: 'client_secret_basic',
        server: {
          enabled: true,
          basePath: '/oauth',
          authorizePath: '/oauth/authorize',
          tokenPath: '/oauth/token',
          introspectionPath: '/oauth/introspect',
          revocationPath: '/oauth/revoke',
          metadataPath: '/.well-known/oauth-authorization-server',
          issuer: '',
          autoApprove: true,
          requireAuthenticatedUser: true,
          requireConsent: false,
          allowHttp: false,
        },
      },
    },
    swagger: {
      enabled: false,
      docsPath: '/docs',
      jsonPath: '/openapi.json',
      documentPath: 'openapi.json',
      explorer: true,
    },
    architecture: {
      strictLayers: false,
    },
    autoMountApps: false,
    loaders: [],
    apps: [],
  };
}

async function importDefaultIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const loaded = await import(moduleUrl);
  return loaded?.default ?? null;
}

export async function loadProjectConfig(rootDir, logger = null) {
  const config = defaultConfig(rootDir);

  const settingsFile = path.join(rootDir, 'settings.js');
  const settingsDir = path.join(rootDir, 'settings');
  const indexFile = path.join(settingsDir, 'index.js');
  const dbFile = path.join(settingsDir, 'db.js');
  const cacheFile = path.join(settingsDir, 'cache.js');
  const appsFile = path.join(settingsDir, 'apps.js');

  const [settingsConfig, indexConfig, dbConfig, cacheConfig, appsConfig] = await Promise.all([
    importDefaultIfExists(settingsFile),
    importDefaultIfExists(indexFile),
    importDefaultIfExists(dbFile),
    importDefaultIfExists(cacheFile),
    importDefaultIfExists(appsFile),
  ]);

  let merged = config;

  if (settingsConfig && isPlainObject(settingsConfig)) {
    merged = deepMerge(merged, settingsConfig);
  }

  if (indexConfig && isPlainObject(indexConfig)) {
    merged = deepMerge(merged, indexConfig);
  }

  if (dbConfig && isPlainObject(dbConfig)) {
    merged.database = deepMerge(merged.database, dbConfig);
  }

  if (cacheConfig && isPlainObject(cacheConfig)) {
    merged.cache = deepMerge(merged.cache, cacheConfig);
  }

  if (appsConfig && (!Array.isArray(merged.apps) || merged.apps.length === 0)) {
    merged.apps = normalizeApps(appsConfig);
  } else {
    merged.apps = normalizeApps(merged.apps);
  }

  merged = applyEnvironmentOverrides(merged, logger);
  merged.apps = normalizeApps(merged.apps);

  if (logger) {
    logger.debug('Configuration loaded for project root: %s', rootDir);
  }

  return merged;
}

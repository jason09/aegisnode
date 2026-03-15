import fs from 'fs';
import fsPromises from 'fs/promises';
import http from 'http';
import https from 'https';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import express from 'express';
import ejs from 'ejs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { Server as SocketIOServer } from 'socket.io';
import { createContainer } from './container.js';
import { createEventBus } from './events.js';
import { createLogger } from './logger.js';
import { createCache } from './cache.js';
import { deepMerge, loadProjectConfig, normalizeApps } from './config.js';
import { createAuthManager, normalizeAuthConfig } from './auth.js';
import { initializeDatabase, closeDatabase } from './database.js';
import { runLoaders } from './loaders.js';
import { createRuntimeHelpers } from './helpers.js';
import { createUploadManager, isMultipartRequestContentType, normalizeUploadsConfig } from './upload.js';

const ROUTE_DEFINITION = 'aegis:routes';
const PROJECT_ROUTE_DEFINITION = 'aegis:project-routes';
const DEFAULT_INSTALL_TEMPLATE_PATH = fileURLToPath(new URL('./views/default-install.ejs', import.meta.url));
const RAW_HTML_SYMBOL = Symbol('aegis:raw-html');
const EMPTY_ROUTE_CONTEXT = Object.freeze({});
const REQUEST_I18N_CONTEXT = new AsyncLocalStorage();

function exists(filePath) {
  return fs.existsSync(filePath);
}

function isRouterInstance(value) {
  return Boolean(value) && typeof value === 'function' && typeof value.use === 'function';
}

function stripFileExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function normalizeControllerName(fileName) {
  return stripFileExtension(fileName).replace(/\.controller$/i, '').replace(/\.view$/i, '');
}

function normalizeServiceName(fileName) {
  return stripFileExtension(fileName).replace(/\.service$/i, '');
}

function normalizeModelName(fileName) {
  return stripFileExtension(fileName).replace(/\.model$/i, '');
}

function normalizeValidatorName(fileName) {
  return stripFileExtension(fileName).replace(/\.validator$/i, '');
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeArchitectureConfig(rawArchitecture) {
  const architecture = isPlainObject(rawArchitecture) ? rawArchitecture : {};

  return {
    strictLayers: architecture.strictLayers === true,
  };
}

function normalizeMountPrefix(value) {
  if (!value || value === '/') {
    return '/';
  }

  return `/${String(value).trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function normalizeRoutePrefix(value, fallback) {
  const normalized = normalizeMountPrefix(value || fallback);
  return normalized === '/' ? fallback : normalized;
}

function normalizeApiConfig(rawApi, apps = []) {
  const api = isPlainObject(rawApi) ? rawApi : {};
  const configuredApps = Array.isArray(api.apps)
    ? api.apps
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
    : [];

  const appMounts = new Map(
    (Array.isArray(apps) ? apps : [])
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string')
      .map((entry) => [entry.name, normalizeMountPrefix(entry.mount || `/${entry.name}`)]),
  );

  const mounts = [];
  for (const appName of configuredApps) {
    const mount = normalizeMountPrefix(appMounts.get(appName) || `/${appName}`);
    if (!mounts.includes(mount)) {
      mounts.push(mount);
    }
  }

  return {
    apps: configuredApps,
    mounts,
    disableCsrf: api.disableCsrf !== false,
    requireJsonForUnsafeMethods: api.requireJsonForUnsafeMethods !== false,
    noStoreHeaders: api.noStoreHeaders !== false,
  };
}

function normalizeSwaggerConfig(rawSwagger) {
  const swagger = isPlainObject(rawSwagger) ? rawSwagger : {};

  return {
    enabled: swagger.enabled === true,
    docsPath: normalizeRoutePrefix(swagger.docsPath, '/docs'),
    jsonPath: normalizeRoutePrefix(swagger.jsonPath, '/openapi.json'),
    document: isPlainObject(swagger.document) ? swagger.document : null,
    documentPath: typeof swagger.documentPath === 'string' && swagger.documentPath.trim().length > 0
      ? swagger.documentPath.trim()
      : 'openapi.json',
    explorer: swagger.explorer !== false,
  };
}

function normalizeHttpsPathValue(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeHttpsPathList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }

  const normalized = normalizeHttpsPathValue(value);
  return normalized ? [normalized] : [];
}

function normalizeHttpsAssetValue(value) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value;
  }

  return null;
}

function normalizeHttpsAssetList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeHttpsAssetValue(entry))
      .filter((entry) => entry !== null);
  }

  const normalized = normalizeHttpsAssetValue(value);
  return normalized ? [normalized] : [];
}

function normalizeHttpsConfig(rawHttps) {
  const httpsConfig = rawHttps === true
    ? { enabled: true }
    : (isPlainObject(rawHttps) ? rawHttps : {});

  return {
    enabled: httpsConfig.enabled === true,
    key: normalizeHttpsAssetValue(httpsConfig.key),
    cert: normalizeHttpsAssetValue(httpsConfig.cert),
    ca: normalizeHttpsAssetList(httpsConfig.ca),
    pfx: normalizeHttpsAssetValue(httpsConfig.pfx),
    keyPath: normalizeHttpsPathValue(httpsConfig.keyPath),
    certPath: normalizeHttpsPathValue(httpsConfig.certPath),
    caPath: normalizeHttpsPathList(httpsConfig.caPath),
    pfxPath: normalizeHttpsPathValue(httpsConfig.pfxPath),
    passphrase: typeof httpsConfig.passphrase === 'string' ? httpsConfig.passphrase : '',
    options: isPlainObject(httpsConfig.options) ? { ...httpsConfig.options } : {},
  };
}

function isClassConstructor(value) {
  if (typeof value !== 'function') {
    return false;
  }

  const source = Function.prototype.toString.call(value);
  return source.startsWith('class ');
}

function markRawHtml(value) {
  return { [RAW_HTML_SYMBOL]: String(value) };
}

function isRawHtml(value) {
  return Boolean(value) && typeof value === 'object' && RAW_HTML_SYMBOL in value;
}

function escapeHtmlValue(value) {
  if (isRawHtml(value)) {
    return value[RAW_HTML_SYMBOL];
  }

  return ejs.escapeXML(value);
}

function normalizeTemplateName(templateName, label = 'template') {
  if (typeof templateName !== 'string' || templateName.trim().length === 0) {
    throw new Error(`${label} name must be a non-empty string.`);
  }

  const normalized = templateName
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\.ejs$/i, '');

  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid ${label} name "${templateName}"`);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '..')) {
    throw new Error(`Invalid ${label} name "${templateName}"`);
  }

  return normalized;
}

function normalizeTemplatesConfig(rawTemplates, rootDir) {
  if (rawTemplates === false) {
    return {
      enabled: false,
      engine: 'ejs',
      dir: 'templates',
      root: path.join(rootDir, 'templates'),
      base: null,
      appBases: {},
      locals: {},
    };
  }

  const source = rawTemplates && typeof rawTemplates === 'object' ? rawTemplates : {};
  const enabled = source.enabled !== false;
  const engine = String(source.engine || 'ejs').toLowerCase();

  if (engine !== 'ejs') {
    throw new Error(`Unsupported template engine "${engine}". Only "ejs" is supported.`);
  }

  const dir = typeof source.dir === 'string' && source.dir.trim().length > 0
    ? source.dir.trim()
    : 'templates';
  const root = path.isAbsolute(dir) ? dir : path.join(rootDir, dir);
  const base = source.base === false || source.base === null
    ? null
    : (typeof source.base === 'string' && source.base.trim().length > 0
        ? normalizeTemplateName(source.base, 'base template')
        : 'base');
  const appBasesSource = isPlainObject(source.appBases) ? source.appBases : {};
  const appBases = {};
  for (const [appName, layoutName] of Object.entries(appBasesSource)) {
    if (typeof appName !== 'string' || appName.trim().length === 0) {
      continue;
    }

    const normalizedAppName = appName.trim();
    if (layoutName === false || layoutName === null) {
      appBases[normalizedAppName] = null;
      continue;
    }

    if (typeof layoutName === 'string' && layoutName.trim().length > 0) {
      appBases[normalizedAppName] = normalizeTemplateName(layoutName, 'app base template for ' + normalizedAppName);
    }
  }

  const locals = typeof source.locals === 'function'
    ? source.locals
    : (isPlainObject(source.locals) ? source.locals : {});

  return {
    enabled,
    engine,
    dir,
    root,
    base,
    appBases,
    locals,
  };
}

function resolveTemplateFilePath(templatesRoot, templateName) {
  const normalizedName = normalizeTemplateName(templateName);
  const target = path.resolve(templatesRoot, `${normalizedName}.ejs`);
  const relative = path.relative(templatesRoot, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid template path "${templateName}"`);
  }

  return target;
}

async function renderTemplateFile({ templatesRoot, templateName, locals }) {
  const templateFile = resolveTemplateFilePath(templatesRoot, templateName);
  return ejs.renderFile(templateFile, locals, {
    async: true,
    escape: escapeHtmlValue,
  });
}

function normalizeSecurityHeadersConfig(rawSecurity) {
  const security = isPlainObject(rawSecurity) ? rawSecurity : {};
  const headers = isPlainObject(security.headers) ? security.headers : {};
  const csp = isPlainObject(headers.csp) ? headers.csp : {};

  const directives = isPlainObject(csp.directives) ? csp.directives : {};

  return {
    enabled: headers.enabled !== false,
    csp: {
      enabled: csp.enabled !== false,
      reportOnly: csp.reportOnly === true,
      directives,
    },
  };
}

function buildCspDirectives(userDirectives) {
  const defaults = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'ws:', 'wss:'],
  };

  const merged = { ...defaults };

  for (const [key, value] of Object.entries(userDirectives || {})) {
    if (value === false || value === null) {
      delete merged[key];
      continue;
    }

    if (Array.isArray(value)) {
      merged[key] = value.map((item) => String(item));
      continue;
    }

    if (typeof value === 'string') {
      merged[key] = [value];
    }
  }

  return merged;
}

function normalizeSameSite(value) {
  if (value === false) {
    return false;
  }

  const normalized = String(value || 'lax').toLowerCase();
  if (normalized === 'strict') {
    return 'strict';
  }
  if (normalized === 'none') {
    return 'none';
  }
  return 'lax';
}

function normalizeCsrfConfig(rawSecurity) {
  const security = isPlainObject(rawSecurity) ? rawSecurity : {};
  const csrf = isPlainObject(security.csrf) ? security.csrf : {};
  const secureRaw = csrf.secure;

  return {
    enabled: csrf.enabled !== false,
    rejectForms: csrf.rejectForms !== false,
    rejectUnsafeMethods: csrf.rejectUnsafeMethods !== false,
    cookieName: typeof csrf.cookieName === 'string' && csrf.cookieName.trim().length > 0
      ? csrf.cookieName.trim()
      : '_aegis_csrf',
    fieldName: typeof csrf.fieldName === 'string' && csrf.fieldName.trim().length > 0
      ? csrf.fieldName.trim()
      : '_csrf',
    headerName: typeof csrf.headerName === 'string' && csrf.headerName.trim().length > 0
      ? csrf.headerName.trim().toLowerCase()
      : 'x-csrf-token',
    requireSignedCookie: csrf.requireSignedCookie !== false,
    sameSite: normalizeSameSite(csrf.sameSite),
    secure: secureRaw === true || secureRaw === false ? secureRaw : 'auto',
    httpOnly: csrf.httpOnly !== false,
    path: typeof csrf.path === 'string' && csrf.path.trim().length > 0 ? csrf.path : '/',
  };
}

function resolveAppSecret(rawSecurity) {
  const security = isPlainObject(rawSecurity) ? rawSecurity : {};
  if (typeof security.appSecret !== 'string') {
    return '';
  }
  const secret = security.appSecret.trim();
  return secret.length >= 16 ? secret : '';
}

function generateAppSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureAppSecret(config, rootDir, logger) {
  if (!isPlainObject(config.security)) {
    config.security = {};
  }

  const configuredSecret = resolveAppSecret(config.security);
  if (configuredSecret) {
    config.security.appSecret = configuredSecret;
    return configuredSecret;
  }

  const secretDirectory = path.join(rootDir || process.cwd(), '.aegis');
  const secretFile = path.join(secretDirectory, 'app-secret');

  if (exists(secretFile)) {
    try {
      const persistedSecret = fs.readFileSync(secretFile, 'utf8').trim();
      if (persistedSecret.length >= 16) {
        config.security.appSecret = persistedSecret;
        logger.warn(
          'security.appSecret is missing; using persisted fallback secret from %s. Prefer APP_SECRET or settings.security.appSecret.',
          secretFile,
        );
        return persistedSecret;
      }
    } catch (error) {
      logger.warn(
        'security.appSecret fallback file could not be read at %s: %s',
        secretFile,
        error?.message || String(error),
      );
    }
  }

  const generatedSecret = generateAppSecret();
  config.security.appSecret = generatedSecret;

  try {
    fs.mkdirSync(secretDirectory, { recursive: true });
    fs.writeFileSync(secretFile, `${generatedSecret}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    logger.warn(
      'security.appSecret is missing; generated and persisted a fallback secret at %s. Prefer APP_SECRET or settings.security.appSecret.',
      secretFile,
    );
  } catch (error) {
    logger.warn(
      'security.appSecret is missing; generated an in-memory fallback secret for this boot because persistence failed: %s',
      error?.message || String(error),
    );
  }

  return generatedSecret;
}

function signToken(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

function encodeCsrfCookieValue(token, secret) {
  if (!secret) {
    return token;
  }
  return `${token}.${signToken(token, secret)}`;
}

function decodeCsrfCookieValue(cookieValue, secret) {
  if (typeof cookieValue !== 'string' || cookieValue.length === 0) {
    return { valid: false, token: '' };
  }

  if (!secret) {
    return { valid: true, token: cookieValue };
  }

  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex <= 0) {
    return { valid: false, token: '' };
  }

  const token = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);
  const expected = signToken(token, secret);

  return {
    valid: constantTimeEqual(signature, expected),
    token,
  };
}

function normalizeTrustProxySetting(value) {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return false;
}

function resolveTrustProxySetting(config) {
  const security = isPlainObject(config?.security) ? config.security : {};
  const ddos = isPlainObject(security.ddos) ? security.ddos : {};
  const topLevel = normalizeTrustProxySetting(config?.trustProxy);
  if (topLevel !== false) {
    return topLevel;
  }

  const legacy = normalizeTrustProxySetting(ddos.trustProxy);
  return legacy !== false ? legacy : false;
}

function applyTrustProxySetting(expressApp, config, logger) {
  const trustProxy = resolveTrustProxySetting(config);
  config.trustProxy = trustProxy;
  expressApp.set('trust proxy', trustProxy);

  if (trustProxy !== false) {
    logger.debug('Express trust proxy enabled: %o', trustProxy);
  }
}

function normalizeDdosConfig(rawSecurity) {
  const security = isPlainObject(rawSecurity) ? rawSecurity : {};
  const ddos = isPlainObject(security.ddos) ? security.ddos : {};
  const windowMsNumber = Number(ddos.windowMs);
  const maxRequestsNumber = Number(ddos.maxRequests);
  const statusCodeNumber = Number(ddos.statusCode);

  const skipPaths = Array.isArray(ddos.skipPaths)
    ? ddos.skipPaths
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => {
        const trimmed = entry.trim();
        if (trimmed === '/') {
          return '/';
        }
        return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
      })
    : ['/health'];

  return {
    enabled: ddos.enabled !== false,
    windowMs: Number.isFinite(windowMsNumber) && windowMsNumber > 0 ? Math.floor(windowMsNumber) : 60_000,
    maxRequests: Number.isFinite(maxRequestsNumber) && maxRequestsNumber > 0 ? Math.floor(maxRequestsNumber) : 120,
    message: typeof ddos.message === 'string' && ddos.message.trim().length > 0
      ? ddos.message.trim()
      : 'Too many requests, please try again later.',
    statusCode: Number.isFinite(statusCodeNumber) && statusCodeNumber >= 400 ? Math.floor(statusCodeNumber) : 429,
    standardHeaders: ddos.standardHeaders !== false,
    legacyHeaders: ddos.legacyHeaders === true,
    skipSuccessfulRequests: ddos.skipSuccessfulRequests === true,
    skipFailedRequests: ddos.skipFailedRequests === true,
    trustProxy: normalizeTrustProxySetting(ddos.trustProxy),
    store: ddos.store && typeof ddos.store === 'object' ? ddos.store : null,
    skipPaths,
  };
}

const DB_LIBRARY_PATTERN = /\b(querymesh|mongoose|pg|postgres|postgresql|mysql|mysql2|mssql|sequelize|mongodb|knex|@prisma\/client)\b/i;
const IMPORT_FROM_PATTERN = /import\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_SIDE_EFFECT_PATTERN = /import\s+['"]([^'"]+)['"]/g;
const REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const MODEL_IMPORT_PATH_PATTERN = /(?:^|\/)(models(?:\.js)?|[^/]+\.model(?:\.js)?)$/i;

function extractImportSpecifiers(source) {
  const imports = [];
  const patterns = [IMPORT_FROM_PATTERN, IMPORT_SIDE_EFFECT_PATTERN, REQUIRE_PATTERN];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      imports.push(match[1]);
      match = pattern.exec(source);
    }
  }

  return imports;
}

function routeFileHasModelAccess(content) {
  if (/['"]model:[^'"]+['"]/i.test(content)) {
    return true;
  }

  const imports = extractImportSpecifiers(content);
  return imports.some((specifier) => MODEL_IMPORT_PATH_PATTERN.test(specifier));
}

function fileImportsDatabaseLibrary(content) {
  const imports = extractImportSpecifiers(content);
  return imports.some((specifier) => DB_LIBRARY_PATTERN.test(specifier));
}

function serviceFileHasDatabaseAccess(content) {
  return /\b(dbClient|database)\b/.test(content);
}

async function collectStrictLayerFiles(appRoot) {
  const routeFiles = [];
  const serviceFiles = [];

  const routesFile = path.join(appRoot, 'routes.js');
  if (exists(routesFile)) {
    routeFiles.push(routesFile);
  }

  const routesDir = path.join(appRoot, 'routes');
  for (const fileName of await loadDirectoryFiles(routesDir)) {
    if (!fileName.endsWith('.js')) {
      continue;
    }
    routeFiles.push(path.join(routesDir, fileName));
  }

  const servicesFile = path.join(appRoot, 'services.js');
  if (exists(servicesFile)) {
    serviceFiles.push(servicesFile);
  }

  for (const fileName of await loadDirectoryFiles(appRoot)) {
    if (!fileName.endsWith('.service.js')) {
      continue;
    }
    serviceFiles.push(path.join(appRoot, fileName));
  }

  const servicesDir = path.join(appRoot, 'services');
  for (const fileName of await loadDirectoryFiles(servicesDir)) {
    if (!fileName.endsWith('.js')) {
      continue;
    }
    serviceFiles.push(path.join(servicesDir, fileName));
  }

  return { routeFiles, serviceFiles };
}

async function enforceStrictLayersForFile(filePath, checks) {
  const source = await fsPromises.readFile(filePath, 'utf8');

  for (const check of checks) {
    if (check.when(source)) {
      throw new Error(`[strictLayers] ${check.message} (${filePath})`);
    }
  }
}

async function enforceStrictLayerArchitecture({ appName, appRoot }) {
  const { routeFiles, serviceFiles } = await collectStrictLayerFiles(appRoot);

  const routeChecks = [
    {
      when: (source) => routeFileHasModelAccess(source),
      message: `Routes in app "${appName}" must call services only (model imports/tokens are not allowed)`,
    },
    {
      when: (source) => fileImportsDatabaseLibrary(source),
      message: `Routes in app "${appName}" must not import database libraries`,
    },
  ];

  const serviceChecks = [
    {
      when: (source) => fileImportsDatabaseLibrary(source),
      message: `Services in app "${appName}" must not import database libraries directly`,
    },
    {
      when: (source) => serviceFileHasDatabaseAccess(source),
      message: `Services in app "${appName}" must access data through models (dbClient/database usage is not allowed)`,
    },
  ];

  for (const filePath of routeFiles) {
    await enforceStrictLayersForFile(filePath, routeChecks);
  }

  for (const filePath of serviceFiles) {
    await enforceStrictLayersForFile(filePath, serviceChecks);
  }
}

async function enforceStrictProjectRoutes(projectRoutesFile) {
  if (!projectRoutesFile || !exists(projectRoutesFile)) {
    return;
  }

  await enforceStrictLayersForFile(projectRoutesFile, [
    {
      when: (source) => routeFileHasModelAccess(source),
      message: 'Project routes must call services only (model imports/tokens are not allowed)',
    },
    {
      when: (source) => fileImportsDatabaseLibrary(source),
      message: 'Project routes must not import database libraries',
    },
  ]);
}

function parseLayerIdentifier(identifier, defaultAppName, layerName) {
  const normalized = typeof identifier === 'string' ? identifier.trim() : '';
  if (!normalized) {
    throw new Error(`Invalid ${layerName} identifier. Provide "<name>" or "<app>.<name>".`);
  }

  const parts = normalized.split('.').filter(Boolean);
  if (parts.length === 1) {
    if (!defaultAppName) {
      throw new Error(`Ambiguous ${layerName} identifier "${identifier}". Use "<app>.<name>".`);
    }
    return {
      appName: defaultAppName,
      name: parts[0],
    };
  }

  if (parts.length === 2) {
    return {
      appName: parts[0],
      name: parts[1],
    };
  }

  throw new Error(`Invalid ${layerName} identifier "${identifier}". Use "<name>" or "<app>.<name>".`);
}

function instantiateLayerEntry(entry, dependencies) {
  if (isClassConstructor(entry)) {
    return new entry(dependencies);
  }

  return entry;
}

function createLayerAccessors({ container, context }) {
  const modelInstanceCache = new Map();
  const validatorInstanceCache = new Map();
  const serviceInstanceCache = new Map();

  function createModelAccessor(defaultAppName = null) {
    return {
      get(identifier) {
        const { appName, name } = parseLayerIdentifier(identifier, defaultAppName, 'model');
        const scopedToken = `model:${appName}.${name}`;
        const fallbackToken = `model:${appName}`;
        const token = container.has(scopedToken) ? scopedToken : fallbackToken;

        if (!container.has(token)) {
          throw new Error(`Model not found for token ${scopedToken}`);
        }

        if (modelInstanceCache.has(token)) {
          return modelInstanceCache.get(token);
        }

        const model = instantiateLayerEntry(container.get(token), {
          appName,
          config: context.config,
          env: context.env,
          i18n: context.i18n,
          logger: context.logger,
          events: context.events,
          cache: context.cache,
          io: context.io,
          helpers: context.helpers,
          jlive: context.jlive,
          dbClient: context.dbClient,
          database: context.database,
        });

        modelInstanceCache.set(token, model);
        return model;
      },
      has(identifier) {
        const { appName, name } = parseLayerIdentifier(identifier, defaultAppName, 'model');
        return container.has(`model:${appName}.${name}`) || container.has(`model:${appName}`);
      },
      forApp(appName) {
        return createModelAccessor(appName);
      },
    };
  }

  function createServiceAccessor(defaultAppName = null) {
    return {
      get(identifier) {
        const { appName, name } = parseLayerIdentifier(identifier, defaultAppName, 'service');
        const scopedToken = `service:${appName}.${name}`;
        const fallbackToken = `service:${appName}`;
        const token = container.has(scopedToken) ? scopedToken : fallbackToken;

        if (!container.has(token)) {
          throw new Error(`Service not found for token ${scopedToken}`);
        }

        if (serviceInstanceCache.has(token)) {
          return serviceInstanceCache.get(token);
        }

        const services = createServiceAccessor(appName);
        const models = createModelAccessor(appName);
        const validators = createValidatorAccessor(appName);
        const service = instantiateLayerEntry(container.get(token), {
          appName,
          config: context.config,
          env: context.env,
          i18n: context.i18n,
          logger: context.logger,
          events: context.events,
          cache: context.cache,
          io: context.io,
          auth: context.auth,
          helpers: context.helpers,
          jlive: context.jlive,
          models,
          validators,
          services,
        });

        serviceInstanceCache.set(token, service);
        return service;
      },
      has(identifier) {
        const { appName, name } = parseLayerIdentifier(identifier, defaultAppName, 'service');
        return container.has(`service:${appName}.${name}`) || container.has(`service:${appName}`);
      },
      forApp(appName) {
        return createServiceAccessor(appName);
      },
    };
  }

  function createValidatorAccessor(defaultAppName = null) {
    return {
      get(identifier) {
        const { appName, name } = parseLayerIdentifier(identifier, defaultAppName, 'validator');
        const scopedToken = `validator:${appName}.${name}`;
        const fallbackToken = `validator:${appName}`;
        const token = container.has(scopedToken) ? scopedToken : fallbackToken;

        if (!container.has(token)) {
          throw new Error(`Validator not found for token ${scopedToken}`);
        }

        if (validatorInstanceCache.has(token)) {
          return validatorInstanceCache.get(token);
        }

        const validator = instantiateLayerEntry(container.get(token), {
          appName,
          config: context.config,
          env: context.env,
          i18n: context.i18n,
          logger: context.logger,
          events: context.events,
          cache: context.cache,
          io: context.io,
          auth: context.auth,
          helpers: context.helpers,
          jlive: context.jlive,
          dbClient: context.dbClient,
          database: context.database,
        });

        validatorInstanceCache.set(token, validator);
        return validator;
      },
      has(identifier) {
        const { appName, name } = parseLayerIdentifier(identifier, defaultAppName, 'validator');
        return container.has(`validator:${appName}.${name}`) || container.has(`validator:${appName}`);
      },
      forApp(appName) {
        return createValidatorAccessor(appName);
      },
    };
  }

  return {
    services: createServiceAccessor(),
    models: createModelAccessor(),
    validators: createValidatorAccessor(),
    servicesForApp: (appName) => createServiceAccessor(appName),
    modelsForApp: (appName) => createModelAccessor(appName),
    validatorsForApp: (appName) => createValidatorAccessor(appName),
  };
}

function buildRouteRuntimeContext({ context, layerAccessors, strictLayers, appDefinition = null }) {
  const appName = appDefinition?.name || null;

  if (!strictLayers) {
    return {
      ...context,
      app: appDefinition || null,
      appName,
      services: appName ? layerAccessors.servicesForApp(appName) : layerAccessors.services,
      models: appName ? layerAccessors.modelsForApp(appName) : layerAccessors.models,
      validators: appName ? layerAccessors.validatorsForApp(appName) : layerAccessors.validators,
      env: context.env,
      i18n: context.i18n,
      declaredAppNames: context.declaredAppNames,
    };
  }

  return {
    rootDir: context.rootDir,
    config: context.config,
    env: context.env,
    i18n: context.i18n,
    logger: context.logger,
    events: context.events,
    cache: context.cache,
    io: context.io,
    auth: context.auth,
    helpers: context.helpers,
    jlive: context.jlive,
    upload: context.upload,
    declaredAppNames: context.declaredAppNames,
    app: appDefinition || null,
    appName,
    services: appName ? layerAccessors.servicesForApp(appName) : layerAccessors.services,
    validators: appName ? layerAccessors.validatorsForApp(appName) : layerAccessors.validators,
  };
}

function bridgeRuntimeContextToRequest(req, runtimeContext = null, appName = null) {
  if (!req || !runtimeContext) {
    return;
  }

  req.aegis = req.aegis || {};

  if (appName && typeof appName === 'string') {
    req.aegis.appName = appName;
  }

  const bindings = {
    config: runtimeContext.config,
    env: runtimeContext.env,
    logger: runtimeContext.logger,
    events: runtimeContext.events,
    cache: runtimeContext.cache,
    io: runtimeContext.io,
    auth: runtimeContext.auth,
    helpers: runtimeContext.helpers,
    jlive: runtimeContext.jlive,
    upload: runtimeContext.upload,
    services: runtimeContext.services,
    models: runtimeContext.models,
    validators: runtimeContext.validators,
    database: runtimeContext.database,
    dbClient: runtimeContext.dbClient,
  };

  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value !== 'undefined' && value !== null) {
      req.aegis[key] = value;
    }
  }

  if (appName && req.aegis.services && req.aegis.validators) {
    req.aegis.app = {
      ...(req.aegis.app || {}),
      name: appName,
      services: req.aegis.services,
      models: req.aegis.models,
      validators: req.aegis.validators,
    };
  }
}

function buildHandlerContext(req, runtimeContext = null, currentApp = null) {
  const aegis = req?.aegis || {};
  const appName = currentApp || aegis.appName || runtimeContext?.appName || null;
  const services = aegis.services ?? runtimeContext?.services ?? null;
  const models = aegis.models ?? runtimeContext?.models ?? null;
  const validators = aegis.validators ?? runtimeContext?.validators ?? null;
  const resolveLayerByAppName = (accessor) => {
    if (!accessor || !appName || typeof accessor.get !== 'function') {
      return null;
    }

    try {
      if (typeof accessor.has === 'function' && !accessor.has(appName)) {
        return null;
      }
      return accessor.get(appName);
    } catch {
      return null;
    }
  };

  const service = resolveLayerByAppName(services);
  const model = resolveLayerByAppName(models);
  const validator = resolveLayerByAppName(validators);

  return {
    appName,
    app: aegis.app || (appName
      ? {
          name: appName,
          services,
          models,
          validators,
        }
      : null),
    config: aegis.config ?? runtimeContext?.config ?? null,
    env: aegis.env ?? runtimeContext?.env ?? null,
    i18n: aegis.i18n ?? runtimeContext?.i18n ?? null,
    logger: aegis.logger ?? runtimeContext?.logger ?? null,
    events: aegis.events ?? runtimeContext?.events ?? null,
    cache: aegis.cache ?? runtimeContext?.cache ?? null,
    io: aegis.io ?? runtimeContext?.io ?? null,
    auth: aegis.auth ?? runtimeContext?.auth ?? null,
    helpers: aegis.helpers ?? runtimeContext?.helpers ?? null,
    jlive: aegis.jlive ?? runtimeContext?.jlive ?? null,
    upload: aegis.upload ?? runtimeContext?.upload ?? null,
    services,
    models,
    validators,
    service,
    model,
    validator,
    database: aegis.database ?? runtimeContext?.database ?? null,
    dbClient: aegis.dbClient ?? runtimeContext?.dbClient ?? null,
  };
}

function parseCookies(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return {};
  }

  const parsed = {};
  const parts = headerValue.split(';');
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) {
      continue;
    }

    try {
      parsed[key] = decodeURIComponent(value);
    } catch {
      parsed[key] = value;
    }
  }

  return parsed;
}

function normalizeLocaleToken(locale, fallback = '') {
  if (typeof locale !== 'string' || locale.trim().length === 0) {
    return fallback;
  }

  return locale.trim().replace(/_/g, '-').toLowerCase();
}

function uniqueStringList(values) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function loadI18nJsonFile(filePath, logger, label = 'i18n translation file') {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(filePath.trim());

  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(content);

    if (!isPlainObject(parsed)) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('%s must contain a JSON object: %s', label, resolvedPath);
      }
      return null;
    }

    return parsed;
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('%s could not be loaded (%s): %s', label, resolvedPath, error?.message || String(error));
    }
    return null;
  }
}

function resolveI18nLocaleMessages(value, { rootDir, locale, logger }) {
  if (isPlainObject(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const rawPath = value.trim();
  const filePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(rootDir || process.cwd(), rawPath);

  return loadI18nJsonFile(filePath, logger, 'i18n.translations.' + locale);
}

function normalizeI18nConfig(rawI18n, rootDir = process.cwd(), logger = null) {
  const source = isPlainObject(rawI18n) ? rawI18n : {};
  const directTranslationsSource = isPlainObject(source.translations)
    ? source.translations
    : (isPlainObject(source.locales)
        ? source.locales
        : (isPlainObject(source.messages) ? source.messages : {}));

  let fileTranslationsSource = {};
  if (typeof source.translationsFile === 'string' && source.translationsFile.trim().length > 0) {
    const rawPath = source.translationsFile.trim();
    const filePath = path.isAbsolute(rawPath)
      ? rawPath
      : path.join(rootDir || process.cwd(), rawPath);

    const loaded = loadI18nJsonFile(filePath, logger, 'i18n.translationsFile');
    if (isPlainObject(loaded)) {
      fileTranslationsSource = loaded;
    }
  }

  const translationsSource = {
    ...fileTranslationsSource,
    ...directTranslationsSource,
  };

  const translations = {};
  for (const [locale, value] of Object.entries(translationsSource)) {
    const normalizedLocale = normalizeLocaleToken(locale);
    if (!normalizedLocale) {
      continue;
    }

    const messages = resolveI18nLocaleMessages(value, {
      rootDir,
      locale: normalizedLocale,
      logger,
    });

    if (!isPlainObject(messages)) {
      continue;
    }

    translations[normalizedLocale] = messages;
  }

  const translationLocales = Object.keys(translations);
  const configuredSupported = Array.isArray(source.supported)
    ? source.supported
      .map((entry) => normalizeLocaleToken(entry))
      .filter(Boolean)
    : [];

  const defaultLocale = normalizeLocaleToken(source.defaultLocale, 'en');
  const fallbackLocale = normalizeLocaleToken(source.fallbackLocale, defaultLocale);

  const supported = uniqueStringList([
    ...configuredSupported,
    ...translationLocales,
    defaultLocale,
    fallbackLocale,
  ]);

  if (supported.length === 0) {
    supported.push(defaultLocale || 'en');
  }

  return {
    enabled: source.enabled === true || translationLocales.length > 0,
    defaultLocale: defaultLocale || 'en',
    fallbackLocale: fallbackLocale || defaultLocale || 'en',
    supported,
    queryParam: typeof source.queryParam === 'string' && source.queryParam.trim().length > 0
      ? source.queryParam.trim()
      : 'lang',
    cookieName: typeof source.cookieName === 'string' && source.cookieName.trim().length > 0
      ? source.cookieName.trim()
      : 'aegis_locale',
    detectFromHeader: source.detectFromHeader !== false,
    detectFromCookie: source.detectFromCookie !== false,
    detectFromQuery: source.detectFromQuery !== false,
    translations,
  };
}

function parseAcceptLanguage(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return [];
  }

  const weighted = [];
  for (const entry of headerValue.split(',')) {
    const [rawTag, ...params] = entry.trim().split(';');
    const tag = normalizeLocaleToken(rawTag);
    if (!tag) {
      continue;
    }

    let quality = 1;
    for (const param of params) {
      const [rawKey, rawValue] = String(param || '').split('=');
      if (String(rawKey || '').trim().toLowerCase() !== 'q') {
        continue;
      }

      const parsed = Number.parseFloat(String(rawValue || '').trim());
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        quality = parsed;
      }
    }

    weighted.push({ tag, quality });
  }

  weighted.sort((left, right) => right.quality - left.quality);
  return weighted.map((entry) => entry.tag);
}

function resolveSupportedLocale(candidate, supportedLocales, fallbackLocale = 'en') {
  const supported = Array.isArray(supportedLocales)
    ? supportedLocales
      .map((entry) => normalizeLocaleToken(entry))
      .filter(Boolean)
    : [];

  if (supported.length === 0) {
    return normalizeLocaleToken(fallbackLocale, 'en');
  }

  const normalizedCandidate = normalizeLocaleToken(candidate);
  if (!normalizedCandidate) {
    return resolveSupportedLocale(fallbackLocale, supported, supported[0]);
  }

  if (normalizedCandidate === '*') {
    return resolveSupportedLocale(fallbackLocale, supported, supported[0]);
  }

  if (supported.includes(normalizedCandidate)) {
    return normalizedCandidate;
  }

  const primary = normalizedCandidate.split('-')[0];
  const primaryMatch = supported.find((locale) => locale === primary || locale.startsWith(`${primary}-`));
  if (primaryMatch) {
    return primaryMatch;
  }

  const fallback = normalizeLocaleToken(fallbackLocale);
  if (fallback && supported.includes(fallback)) {
    return fallback;
  }

  const fallbackPrimary = fallback ? fallback.split('-')[0] : '';
  if (fallbackPrimary) {
    const fallbackPrimaryMatch = supported.find((locale) => locale === fallbackPrimary || locale.startsWith(`${fallbackPrimary}-`));
    if (fallbackPrimaryMatch) {
      return fallbackPrimaryMatch;
    }
  }

  return supported[0];
}

function resolveRequestLocale(req, i18nConfig) {
  const fallbackLocale = i18nConfig.defaultLocale || 'en';
  const supported = i18nConfig.supported || [];

  const useCandidate = (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return null;
    }

    const resolved = resolveSupportedLocale(candidate, supported, fallbackLocale);
    if (resolved) {
      return { locale: resolved, source };
    }
    return null;
  };

  if (i18nConfig.detectFromQuery && i18nConfig.queryParam && req?.query && typeof req.query === 'object') {
    const queryValue = req.query[i18nConfig.queryParam];
    const candidate = typeof queryValue === 'string'
      ? queryValue
      : (Array.isArray(queryValue) && typeof queryValue[0] === 'string' ? queryValue[0] : '');

    const resolved = useCandidate(candidate, 'query');
    if (resolved) {
      return resolved;
    }
  }

  if (i18nConfig.detectFromCookie && i18nConfig.cookieName) {
    const cookies = parseCookies(req?.headers?.cookie || '');
    const resolved = useCandidate(cookies[i18nConfig.cookieName], 'cookie');
    if (resolved) {
      return resolved;
    }
  }

  if (i18nConfig.detectFromHeader) {
    const accepted = parseAcceptLanguage(req?.headers?.['accept-language'] || '');
    for (const candidate of accepted) {
      const resolved = useCandidate(candidate, 'header');
      if (resolved) {
        return resolved;
      }
    }
  }

  return {
    locale: resolveSupportedLocale(fallbackLocale, supported, fallbackLocale),
    source: 'default',
  };
}

function readTranslationValue(translations, key) {
  if (!isPlainObject(translations) || typeof key !== 'string' || key.trim().length === 0) {
    return undefined;
  }

  const normalizedKey = key.trim();
  if (Object.prototype.hasOwnProperty.call(translations, normalizedKey)) {
    return translations[normalizedKey];
  }

  const parts = normalizedKey.split('.').filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  let current = translations;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function formatTranslationValue(value, variables = {}) {
  if (typeof value === 'string') {
    const safeVariables = isPlainObject(variables) ? variables : {};
    return value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, token) => {
      if (Object.prototype.hasOwnProperty.call(safeVariables, token)) {
        return String(safeVariables[token]);
      }
      return match;
    });
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

function resolveTranslationValue(i18nConfig, locale, key) {
  const normalizedLocale = normalizeLocaleToken(locale);
  if (!normalizedLocale || !isPlainObject(i18nConfig.translations)) {
    return undefined;
  }

  const direct = readTranslationValue(i18nConfig.translations[normalizedLocale], key);
  if (direct !== undefined) {
    return direct;
  }

  const primary = normalizedLocale.split('-')[0];
  if (!primary) {
    return undefined;
  }

  for (const [candidateLocale, messages] of Object.entries(i18nConfig.translations)) {
    const normalizedCandidate = normalizeLocaleToken(candidateLocale);
    if (normalizedCandidate === primary || normalizedCandidate.startsWith(`${primary}-`)) {
      const resolved = readTranslationValue(messages, key);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }

  return undefined;
}

function createTranslator(i18nConfig, resolveActiveLocale) {
  return (key, variables = {}, options = {}) => {
    if (typeof key !== 'string' || key.trim().length === 0) {
      return '';
    }

    const normalizedKey = key.trim();
    const safeOptions = isPlainObject(options) ? options : {};
    const requestedLocale = resolveSupportedLocale(
      safeOptions.locale || resolveActiveLocale(),
      i18nConfig.supported,
      i18nConfig.defaultLocale,
    );

    const localesToTry = uniqueStringList([
      requestedLocale,
      i18nConfig.fallbackLocale,
      i18nConfig.defaultLocale,
    ]);

    for (const locale of localesToTry) {
      const value = resolveTranslationValue(i18nConfig, locale, normalizedKey);
      if (value === undefined) {
        continue;
      }

      const rendered = formatTranslationValue(value, variables);
      if (rendered !== null) {
        return rendered;
      }

      return normalizedKey;
    }

    if (typeof safeOptions.defaultValue === 'string') {
      return safeOptions.defaultValue;
    }

    return normalizedKey;
  };
}

function createI18nBridge(i18nConfig, {
  resolveLocale = null,
  resolveLocaleSource = null,
  setLocale = null,
} = {}) {
  const getActiveLocale = () => resolveSupportedLocale(
    typeof resolveLocale === 'function' ? resolveLocale() : i18nConfig.defaultLocale,
    i18nConfig.supported,
    i18nConfig.defaultLocale,
  );

  const bridge = {
    enabled: i18nConfig.enabled,
    defaultLocale: i18nConfig.defaultLocale,
    fallbackLocale: i18nConfig.fallbackLocale,
    supported: [...i18nConfig.supported],
    queryParam: i18nConfig.queryParam,
    cookieName: i18nConfig.cookieName,
    resolveLocale(locale) {
      return resolveSupportedLocale(locale, i18nConfig.supported, i18nConfig.defaultLocale);
    },
    t: createTranslator(i18nConfig, getActiveLocale),
    forLocale(locale) {
      const resolvedLocale = resolveSupportedLocale(
        locale,
        i18nConfig.supported,
        i18nConfig.defaultLocale,
      );

      return createI18nBridge(i18nConfig, {
        resolveLocale: () => resolvedLocale,
      });
    },
  };

  Object.defineProperty(bridge, 'locale', {
    enumerable: true,
    get: () => getActiveLocale(),
  });

  Object.defineProperty(bridge, 'localeSource', {
    enumerable: true,
    get: () => {
      if (typeof resolveLocaleSource !== 'function') {
        return undefined;
      }

      const source = resolveLocaleSource();
      return typeof source === 'string' && source.trim().length > 0 ? source : undefined;
    },
  });

  if (typeof setLocale === 'function') {
    bridge.setLocale = (nextLocale, options = {}) => setLocale(nextLocale, options);
  }

  return bridge;
}

function createRuntimeI18n(i18nConfig) {
  return createI18nBridge(i18nConfig, {
    resolveLocale: () => REQUEST_I18N_CONTEXT.getStore()?.locale || i18nConfig.defaultLocale,
    resolveLocaleSource: () => REQUEST_I18N_CONTEXT.getStore()?.source || 'default',
    setLocale: (nextLocale, options = {}) => {
      const store = REQUEST_I18N_CONTEXT.getStore();
      if (store && typeof store.setLocale === 'function') {
        return store.setLocale(nextLocale, options);
      }

      return resolveSupportedLocale(nextLocale, i18nConfig.supported, i18nConfig.defaultLocale);
    },
  });
}

function createRequestI18n(i18nConfig, req) {
  return createI18nBridge(i18nConfig, {
    resolveLocale: () => req?.aegis?.locale,
    resolveLocaleSource: () => req?.aegis?.localeSource,
    setLocale: (nextLocale, options = {}) => {
      if (typeof req?.aegis?.setLocale === 'function') {
        return req.aegis.setLocale(nextLocale, options);
      }

      return resolveSupportedLocale(nextLocale, i18nConfig.supported, i18nConfig.defaultLocale);
    },
  });
}


function isSafeHttpMethod(method) {
  const upper = String(method || '').toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
}

function isFormSubmissionRequest(req) {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  return contentType.includes('application/x-www-form-urlencoded')
    || contentType.includes('multipart/form-data')
    || contentType.includes('text/plain');
}

function isJsonRequestContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  return normalized.includes('application/json') || normalized.includes('+json');
}

function hasRequestBody(req) {
  const contentLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return true;
  }

  return typeof req.headers?.['transfer-encoding'] === 'string';
}

function requestPathMatchesPrefix(requestPath, prefix) {
  if (prefix === '/') {
    return true;
  }

  return requestPath === prefix || requestPath.startsWith(`${prefix}/`);
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function resolveSecureCookieFlag(req, secureSetting) {
  if (secureSetting === true || secureSetting === false) {
    return secureSetting;
  }

  // req.secure respects Express trust proxy settings and avoids trusting spoofed headers by default.
  return Boolean(req.secure);
}

function resolveHttpsAssetPath(rootDir, filePath, label) {
  const normalizedPath = normalizeHttpsPathValue(filePath);
  if (!normalizedPath) {
    return '';
  }

  const resolvedPath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.join(rootDir, normalizedPath);

  if (!exists(resolvedPath)) {
    throw new Error(`HTTPS ${label} file not found: ${resolvedPath}`);
  }

  return resolvedPath;
}

function readHttpsAssetFile(rootDir, filePath, label) {
  const resolvedPath = resolveHttpsAssetPath(rootDir, filePath, label);
  if (!resolvedPath) {
    return null;
  }

  try {
    return fs.readFileSync(resolvedPath);
  } catch (error) {
    throw new Error(`HTTPS ${label} file could not be read at ${resolvedPath}: ${error?.message || String(error)}`);
  }
}

function resolveHttpsAsset(rootDir, directValue, filePath, label) {
  const normalizedDirectValue = normalizeHttpsAssetValue(directValue);
  if (normalizedDirectValue) {
    return normalizedDirectValue;
  }

  return readHttpsAssetFile(rootDir, filePath, label);
}

function resolveHttpsAssetList(rootDir, directValue, filePath, label) {
  const directList = normalizeHttpsAssetList(directValue);
  if (directList.length > 0) {
    return directList;
  }

  const filePaths = normalizeHttpsPathList(filePath);
  if (filePaths.length === 0) {
    return [];
  }

  return filePaths.map((entry, index) => readHttpsAssetFile(rootDir, entry, `${label}[${index}]`));
}

function resolveServerProtocol(config) {
  return config?.https?.enabled === true ? 'https' : 'http';
}

function createHttpServer(expressApp, config) {
  const httpsConfig = normalizeHttpsConfig(config.https);
  config.https = httpsConfig;

  if (!httpsConfig.enabled) {
    return {
      server: http.createServer(expressApp),
      protocol: 'http',
    };
  }

  const rootDir = config.rootDir || process.cwd();
  const options = { ...httpsConfig.options };
  const pfx = resolveHttpsAsset(rootDir, httpsConfig.pfx, httpsConfig.pfxPath, 'pfx');
  const key = resolveHttpsAsset(rootDir, httpsConfig.key, httpsConfig.keyPath, 'key');
  const cert = resolveHttpsAsset(rootDir, httpsConfig.cert, httpsConfig.certPath, 'cert');
  const ca = resolveHttpsAssetList(rootDir, httpsConfig.ca, httpsConfig.caPath, 'ca');

  if (!pfx && (!key || !cert)) {
    throw new Error('HTTPS requires either https.pfx/pfxPath or both https.key/keyPath and https.cert/certPath.');
  }

  if (pfx) {
    options.pfx = pfx;
  }
  if (key) {
    options.key = key;
  }
  if (cert) {
    options.cert = cert;
  }
  if (ca.length > 0) {
    options.ca = ca.length === 1 ? ca[0] : ca;
  }
  if (httpsConfig.passphrase) {
    options.passphrase = httpsConfig.passphrase;
  }

  return {
    server: https.createServer(options, expressApp),
    protocol: 'https',
  };
}

function extractCsrfToken(req, csrfConfig) {
  const fromHeader = req.headers?.[csrfConfig.headerName];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) {
    return fromHeader;
  }
  if (Array.isArray(fromHeader) && fromHeader.length > 0) {
    return String(fromHeader[0]);
  }

  if (req.body && typeof req.body === 'object') {
    const fromBody = req.body[csrfConfig.fieldName];
    if (typeof fromBody === 'string' && fromBody.length > 0) {
      return fromBody;
    }
  }

  return '';
}

async function importModule(filePath) {
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

export function defineRoutes(register) {
  if (typeof register !== 'function') {
    throw new Error('defineRoutes requires a function.');
  }

  return {
    __aegisType: ROUTE_DEFINITION,
    register,
  };
}

export function defineProjectRoutes({ apps = [], routes = null } = {}) {
  if (routes !== null && typeof routes !== 'function') {
    throw new Error('defineProjectRoutes.routes must be a function or null.');
  }

  return {
    __aegisType: PROJECT_ROUTE_DEFINITION,
    apps,
    routes,
  };
}

function getScopedLayerAccessor(accessor, appName) {
  if (!accessor) {
    return accessor;
  }

  if (appName && typeof accessor.forApp === 'function') {
    return accessor.forApp(appName);
  }

  return accessor;
}

function buildControllerDependencies({ appName, runtimeContext = null, container }) {
  return {
    appName,
    rootDir: runtimeContext?.rootDir,
    config: runtimeContext?.config,
    env: runtimeContext?.env,
    i18n: runtimeContext?.i18n,
    logger: runtimeContext?.logger,
    events: runtimeContext?.events,
    cache: runtimeContext?.cache,
    io: runtimeContext?.io,
    auth: runtimeContext?.auth,
    helpers: runtimeContext?.helpers,
    jlive: runtimeContext?.jlive,
    upload: runtimeContext?.upload,
    services: getScopedLayerAccessor(runtimeContext?.services, appName),
    models: getScopedLayerAccessor(runtimeContext?.models, appName),
    validators: getScopedLayerAccessor(runtimeContext?.validators, appName),
    database: runtimeContext?.database,
    dbClient: runtimeContext?.dbClient,
    container: runtimeContext?.container || container,
    app: runtimeContext?.app || null,
  };
}

function resolveControllerReference(reference, { container, currentApp, runtimeContext = null }) {
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    throw new Error('Controller reference must be a non-empty string.');
  }

  const parts = reference.split('.').filter(Boolean);
  let appName = currentApp;
  let controllerName;
  let actionName;

  if (parts.length >= 3) {
    [appName, controllerName, actionName] = parts;
  } else if (parts.length === 2) {
    [controllerName, actionName] = parts;
  } else if (parts.length === 1) {
    [controllerName] = parts;
    actionName = 'index';
  }

  if (!appName) {
    throw new Error(`Controller reference \"${reference}\" is missing app context.`);
  }

  const token = `controller:${appName}.${controllerName}`;
  let controller = container.getOrNull(token);

  if (!controller) {
    throw new Error(`Controller not found for token ${token} (reference: ${reference})`);
  }

  if (
    isClassConstructor(controller)
    && actionName
    && typeof controller.prototype?.[actionName] === 'function'
  ) {
    controller = new controller(buildControllerDependencies({
      appName,
      runtimeContext,
      container,
    }));
    container.set(token, controller);
  }

  if (!actionName) {
    if (typeof controller === 'function') {
      return controller;
    }
    throw new Error(`Controller reference \"${reference}\" did not resolve to a function.`);
  }

  if (!controller || typeof controller[actionName] !== 'function') {
    throw new Error(`Action \"${actionName}\" not found on controller ${token}`);
  }

  return controller[actionName].bind(controller);
}

function buildHandler(candidate, resolveRef, currentApp, runtimeContext = null) {
  if (typeof candidate === 'function') {
    return (req, res, next) => {
      try {
        bridgeRuntimeContextToRequest(req, runtimeContext, currentApp || runtimeContext?.appName || null);
        const handlerContext = buildHandlerContext(req, runtimeContext, currentApp);
        const result = candidate.length >= 4
          ? candidate(handlerContext, req, res, next)
          : candidate(req, res, next);
        if (result && typeof result.then === 'function') {
          result.catch(next);
        }
      } catch (error) {
        next(error);
      }
    };
  }

  if (typeof candidate === 'string') {
    return async (req, res, next) => {
      try {
        bridgeRuntimeContextToRequest(req, runtimeContext, currentApp || runtimeContext?.appName || null);
        const resolved = resolveRef(candidate, currentApp, runtimeContext);
        const handlerContext = buildHandlerContext(req, runtimeContext, currentApp);
        if (typeof resolved === 'function' && resolved.length >= 4) {
          await resolved(handlerContext, req, res, next);
        } else {
          await resolved(req, res, next);
        }
      } catch (error) {
        next(error);
      }
    };
  }

  if (candidate && typeof candidate === 'object') {
    const register = candidate?.__aegisType === ROUTE_DEFINITION
      ? candidate.register
      : candidate.register;

    if (typeof register === 'function') {
      const candidateAppName = typeof candidate.appName === 'string' && candidate.appName.trim().length > 0
        ? candidate.appName.trim()
        : null;
      const declaredAppNames = runtimeContext?.declaredAppNames instanceof Set
        ? runtimeContext.declaredAppNames
        : null;

      if (candidateAppName && declaredAppNames && !declaredAppNames.has(candidateAppName)) {
        throw new Error(
          `App "${candidateAppName}" is not declared in settings.apps. Declare it in settings before mounting routes.`,
        );
      }

      const nestedAppName = currentApp || candidateAppName || runtimeContext?.appName || null;
      const nestedRuntimeContext = runtimeContext && nestedAppName
        ? {
            ...runtimeContext,
            appName: nestedAppName,
            services: runtimeContext.services?.forApp
              ? runtimeContext.services.forApp(nestedAppName)
              : runtimeContext.services,
            models: runtimeContext.models?.forApp
              ? runtimeContext.models.forApp(nestedAppName)
              : runtimeContext.models,
            validators: runtimeContext.validators?.forApp
              ? runtimeContext.validators.forApp(nestedAppName)
              : runtimeContext.validators,
          }
        : runtimeContext;
      let preparedRouter = null;
      let preparing = null;

      const ensurePrepared = async () => {
        if (preparedRouter) {
          return preparedRouter;
        }

        if (!preparing) {
          preparing = (async () => {
            const nestedRouter = express.Router();
            const nestedRouteApi = createRouteApi(
              nestedRouter,
              resolveRef,
              nestedAppName,
              { runtimeContext: nestedRuntimeContext },
            );
            await register(nestedRouteApi, EMPTY_ROUTE_CONTEXT);
            preparedRouter = nestedRouter;
            return preparedRouter;
          })().catch((error) => {
            preparing = null;
            throw error;
          });
        }

        return preparing;
      };

      return async (req, res, next) => {
        try {
          bridgeRuntimeContextToRequest(req, nestedRuntimeContext, nestedAppName);
          const nestedRouter = await ensurePrepared();
          nestedRouter(req, res, next);
        } catch (error) {
          next(error);
        }
      };
    }
  }

  throw new Error('Route handler must be a function, a controller reference string, or a route module with register().');
}

function createDisabledUploadApi() {
  const disabled = () => {
    throw new Error('Uploads are disabled. Enable settings.uploads.enabled=true to use route.upload middleware.');
  };

  return {
    single: disabled,
    array: disabled,
    fields: disabled,
    any: disabled,
    none: disabled,
  };
}

function createRouteApi(router, resolveRef, currentApp, options = {}) {
  const routeState = options?.routeState || null;
  const runtimeContext = options?.runtimeContext || null;
  const api = {};
  api.upload = runtimeContext?.upload || createDisabledUploadApi();

  const verbs = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];
  for (const verb of verbs) {
    api[verb] = (routePath, ...handlers) => {
      if (typeof routePath !== 'string' || !routePath.startsWith('/')) {
        throw new Error(`Invalid route path \"${routePath}\". It must start with /`);
      }

      if (handlers.length === 0) {
        throw new Error(`Route ${verb.toUpperCase()} ${routePath} requires at least one handler.`);
      }

      const chain = handlers.map((entry) => buildHandler(entry, resolveRef, currentApp, runtimeContext));
      router[verb](routePath, ...chain);
      if (routeState) {
        routeState.hasAny = true;
        const canonicalPath = typeof routePath === 'string' ? routePath.trim() : routePath;
        if (verb === 'get' && canonicalPath === '/') {
          routeState.hasRootGet = true;
        }
      }
      return api;
    };
  }

  api.use = (pathOrHandler, ...handlers) => {
    if (typeof pathOrHandler === 'string') {
      const mapped = handlers.map((handler) => buildHandler(handler, resolveRef, currentApp, runtimeContext));
      router.use(pathOrHandler, ...mapped);
      if (routeState) {
        routeState.hasAny = true;
      }
      return api;
    }

    const mapped = [pathOrHandler, ...handlers].map((handler) => buildHandler(handler, resolveRef, currentApp, runtimeContext));
    router.use(...mapped);
    if (routeState) {
      routeState.hasAny = true;
    }
    return api;
  };

  return api;
}

function attachRequestRuntimeBridge(expressApp, runtimeContext = null) {
  const helperSet = isPlainObject(runtimeContext?.helpers) ? runtimeContext.helpers : {};
  const jliveBridge = runtimeContext?.jlive || null;
  const runtimeEnv = isPlainObject(runtimeContext?.env) ? runtimeContext.env : {};
  const authManager = runtimeContext?.auth || null;
  const uploadManager = runtimeContext?.upload || null;
  const services = runtimeContext?.services || null;
  const models = runtimeContext?.models || null;
  const validators = runtimeContext?.validators || null;
  const cache = runtimeContext?.cache || null;
  const events = runtimeContext?.events || null;
  const config = runtimeContext?.config || null;
  const logger = runtimeContext?.logger || null;
  const io = runtimeContext?.io || null;
  const database = runtimeContext?.database || null;
  const dbClient = runtimeContext?.dbClient ?? runtimeContext?.database?.client ?? null;
  const i18nConfig = normalizeI18nConfig(
    config?.i18n,
    runtimeContext?.rootDir || config?.rootDir || process.cwd(),
    logger,
  );

  if (config && isPlainObject(config)) {
    config.i18n = i18nConfig;
  }

  expressApp.use((req, res, next) => {
    REQUEST_I18N_CONTEXT.run({}, () => {
      const requestI18nContext = REQUEST_I18N_CONTEXT.getStore();
      const syncRequestI18nContext = (fallbackSource = 'default') => {
        if (!requestI18nContext) {
          return;
        }

        requestI18nContext.locale = resolveSupportedLocale(
          req.aegis?.locale,
          i18nConfig.supported,
          i18nConfig.defaultLocale,
        );
        requestI18nContext.source = typeof req.aegis?.localeSource === 'string' && req.aegis.localeSource.trim().length > 0
          ? req.aegis.localeSource
          : fallbackSource;
        requestI18nContext.setLocale = typeof req.aegis?.setLocale === 'function'
          ? req.aegis.setLocale
          : null;
      };

      req.aegis = req.aegis || {};
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'helpers')) {
        req.aegis.helpers = helperSet;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'jlive')) {
        req.aegis.jlive = jliveBridge;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'env')) {
        req.aegis.env = runtimeEnv;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'auth')) {
        req.aegis.auth = authManager;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'upload')) {
        req.aegis.upload = uploadManager;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'services')) {
        req.aegis.services = services;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'models')) {
        req.aegis.models = models;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'validators')) {
        req.aegis.validators = validators;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'cache')) {
        req.aegis.cache = cache;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'events')) {
        req.aegis.events = events;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'config')) {
        req.aegis.config = config;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'logger')) {
        req.aegis.logger = logger;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'io')) {
        req.aegis.io = io;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'database')) {
        req.aegis.database = database;
      }
      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'dbClient')) {
        req.aegis.dbClient = dbClient;
      }

      const localeResolution = i18nConfig.enabled
        ? resolveRequestLocale(req, i18nConfig)
        : {
            locale: i18nConfig.defaultLocale,
            source: 'disabled',
          };

      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'locale')) {
        req.aegis.locale = localeResolution.locale;
      }

      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'localeSource')) {
        req.aegis.localeSource = localeResolution.source;
      }

      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'setLocale')) {
        req.aegis.setLocale = (nextLocale, options = {}) => {
          const safeOptions = isPlainObject(options) ? options : {};
          const resolvedLocale = resolveSupportedLocale(
            nextLocale,
            i18nConfig.supported,
            i18nConfig.defaultLocale,
          );

          req.aegis.locale = resolvedLocale;
          req.aegis.localeSource = 'manual';

          const shouldPersist = safeOptions.persist !== false;
          if (shouldPersist && i18nConfig.cookieName && typeof res.cookie === 'function') {
            res.cookie(i18nConfig.cookieName, resolvedLocale, {
              path: '/',
              sameSite: 'lax',
              httpOnly: false,
            });
          }

          syncRequestI18nContext('manual');
          return req.aegis.locale;
        };
      }

      if (!Object.prototype.hasOwnProperty.call(req.aegis, 'i18n')) {
        req.aegis.i18n = createRequestI18n(i18nConfig, req);
      }

      if (!Object.prototype.hasOwnProperty.call(req.aegis, 't')) {
        req.aegis.t = typeof req.aegis.i18n?.t === 'function'
          ? req.aegis.i18n.t
          : createTranslator(
              i18nConfig,
              () => resolveSupportedLocale(req.aegis.locale, i18nConfig.supported, i18nConfig.defaultLocale),
            );
      }

      syncRequestI18nContext(localeResolution.source);

      if (
        i18nConfig.enabled
        && localeResolution.source === 'query'
        && i18nConfig.cookieName
        && typeof res.cookie === 'function'
      ) {
        res.cookie(i18nConfig.cookieName, localeResolution.locale, {
          path: '/',
          sameSite: 'lax',
          httpOnly: false,
        });
      }

      next();
    });
  });
}

async function loadDefaultInstallTemplate(logger) {
  try {
    return await fsPromises.readFile(DEFAULT_INSTALL_TEMPLATE_PATH, 'utf8');
  } catch (error) {
    logger.error('Unable to load default install template: %s', error?.message || String(error));
    throw error;
  }
}

function renderDefaultInstallPage(template, config) {
  return ejs.render(template, {
    appName: config.appName || 'AegisNode',
    env: config.env || 'development',
    createAppCommand: 'aegisnode createapp users',
    nowYear: new Date().getFullYear(),
  });
}

async function loadDirectoryFiles(directoryPath) {
  if (!exists(directoryPath)) {
    return [];
  }

  const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function registerControllers({ appName, appRoot, container, logger }) {
  const sourceDirs = ['controllers', 'views'];

  for (const sourceDir of sourceDirs) {
    const directory = path.join(appRoot, sourceDir);
    const files = await loadDirectoryFiles(directory);

    for (const fileName of files) {
      if (!fileName.endsWith('.js')) {
        continue;
      }

      const filePath = path.join(directory, fileName);
      const loaded = await importModule(filePath);
      const controller = loaded.default ?? loaded;
      const controllerName = normalizeControllerName(fileName);
      container.set(`controller:${appName}.${controllerName}`, controller);
      logger.debug('Controller registered: controller:%s.%s', appName, controllerName);
    }
  }

  const singleFiles = ['controllers.js', 'views.js'];
  for (const fileName of singleFiles) {
    const filePath = path.join(appRoot, fileName);
    if (!exists(filePath)) {
      continue;
    }

    const loaded = await importModule(filePath);
    const controller = loaded.default ?? loaded;
    const controllerName = normalizeControllerName(fileName);
    container.set(`controller:${appName}.${controllerName}`, controller);
    logger.debug('Controller registered: controller:%s.%s', appName, controllerName);
  }
}

async function registerModels({ appName, appRoot, container, logger }) {
  const modelsFile = path.join(appRoot, 'models.js');
  if (exists(modelsFile)) {
    const loaded = await importModule(modelsFile);
    const exported = loaded.default ?? loaded;

    container.set(`model:${appName}`, exported);
    logger.debug('Models registered: model:%s', appName);

    if (exported && typeof exported === 'object') {
      for (const [key, value] of Object.entries(exported)) {
        container.set(`model:${appName}.${key}`, value);
      }
    }
  }

  const rootFiles = await loadDirectoryFiles(appRoot);
  for (const fileName of rootFiles) {
    if (!fileName.endsWith('.model.js')) {
      continue;
    }

    const filePath = path.join(appRoot, fileName);
    const loaded = await importModule(filePath);
    const model = loaded.default ?? loaded;
    const modelName = normalizeModelName(fileName);
    container.set(`model:${appName}.${modelName}`, model);
    logger.debug('Model registered: model:%s.%s', appName, modelName);
  }

  const modelsDir = path.join(appRoot, 'models');
  const files = await loadDirectoryFiles(modelsDir);

  for (const fileName of files) {
    if (!fileName.endsWith('.js')) {
      continue;
    }

    const filePath = path.join(modelsDir, fileName);
    const loaded = await importModule(filePath);
    const model = loaded.default ?? loaded;
    const modelName = normalizeModelName(fileName);
    container.set(`model:${appName}.${modelName}`, model);
    logger.debug('Model registered: model:%s.%s', appName, modelName);
  }
}

async function registerValidators({ appName, appRoot, container, logger }) {
  const validatorsFile = path.join(appRoot, 'validators.js');
  if (exists(validatorsFile)) {
    const loaded = await importModule(validatorsFile);
    const exported = loaded.default ?? loaded;

    container.set(`validator:${appName}`, exported);
    logger.debug('Validators registered: validator:%s', appName);

    if (exported && typeof exported === 'object') {
      for (const [key, value] of Object.entries(exported)) {
        container.set(`validator:${appName}.${key}`, value);
      }
    }
  }

  const rootFiles = await loadDirectoryFiles(appRoot);
  for (const fileName of rootFiles) {
    if (!fileName.endsWith('.validator.js')) {
      continue;
    }

    const filePath = path.join(appRoot, fileName);
    const loaded = await importModule(filePath);
    const validator = loaded.default ?? loaded;
    const validatorName = normalizeValidatorName(fileName);
    container.set(`validator:${appName}.${validatorName}`, validator);
    logger.debug('Validator registered: validator:%s.%s', appName, validatorName);
  }

  const validatorsDir = path.join(appRoot, 'validators');
  const files = await loadDirectoryFiles(validatorsDir);

  for (const fileName of files) {
    if (!fileName.endsWith('.js')) {
      continue;
    }

    const filePath = path.join(validatorsDir, fileName);
    const loaded = await importModule(filePath);
    const validator = loaded.default ?? loaded;
    const validatorName = normalizeValidatorName(fileName);
    container.set(`validator:${appName}.${validatorName}`, validator);
    logger.debug('Validator registered: validator:%s.%s', appName, validatorName);
  }
}

async function registerServices({ appName, appRoot, container, logger }) {
  const servicesFile = path.join(appRoot, 'services.js');
  if (exists(servicesFile)) {
    const loaded = await importModule(servicesFile);
    const exported = loaded.default ?? loaded;

    container.set(`service:${appName}`, exported);
    logger.debug('Service registered: service:%s', appName);

    if (exported && typeof exported === 'object') {
      for (const [key, value] of Object.entries(exported)) {
        container.set(`service:${appName}.${key}`, value);
      }
    }
  }

  const servicesDir = path.join(appRoot, 'services');
  const files = await loadDirectoryFiles(servicesDir);

  for (const fileName of files) {
    if (!fileName.endsWith('.js')) {
      continue;
    }

    const filePath = path.join(servicesDir, fileName);
    const loaded = await importModule(filePath);
    const service = loaded.default ?? loaded;
    const serviceName = normalizeServiceName(fileName);
    container.set(`service:${appName}.${serviceName}`, service);
    logger.debug('Service registered: service:%s.%s', appName, serviceName);
  }
}

async function registerSubscribers({ appName, appRoot, context, logger }) {
  const subscribersFile = exists(path.join(appRoot, 'subscribers.js'))
    ? path.join(appRoot, 'subscribers.js')
    : path.join(appRoot, 'subscribers', 'index.js');

  if (!exists(subscribersFile)) {
    return;
  }

  const loaded = await importModule(subscribersFile);
  const register = loaded.default ?? loaded;

  if (typeof register === 'function') {
    await register({ ...context, appName });
    logger.debug('Subscribers loaded for app %s', appName);
  }
}

async function mountAppRoutes({ appDefinition, appRoot, context, expressApp, routeContext = null }) {
  const routesFile = exists(path.join(appRoot, 'routes.js'))
    ? path.join(appRoot, 'routes.js')
    : path.join(appRoot, 'routes', 'index.js');
  if (!exists(routesFile)) {
    return;
  }

  const loaded = await importModule(routesFile);
  const exported = loaded.default ?? loaded;
  const effectiveRouteContext = routeContext || { ...context, app: appDefinition };
  const appServices = effectiveRouteContext.services?.forApp
    ? effectiveRouteContext.services.forApp(appDefinition.name)
    : effectiveRouteContext.services;
  const appModels = effectiveRouteContext.models?.forApp
    ? effectiveRouteContext.models.forApp(appDefinition.name)
    : effectiveRouteContext.models;
  const appValidators = effectiveRouteContext.validators?.forApp
    ? effectiveRouteContext.validators.forApp(appDefinition.name)
    : effectiveRouteContext.validators;

  const router = express.Router();
  router.use((req, res, next) => {
    req.aegis = req.aegis || {};
    req.aegis.appName = appDefinition.name;
    req.aegis.app = {
      name: appDefinition.name,
      mount: appDefinition.mount,
      services: appServices,
      models: appModels,
      validators: appValidators,
    };
    req.aegis.services = appServices;
    req.aegis.models = appModels;
    req.aegis.validators = appValidators;
    next();
  });
  const routeApi = createRouteApi(
    router,
    (reference, currentApp, runtimeContext) => resolveControllerReference(reference, {
      container: context.container,
      currentApp,
      runtimeContext,
    }),
    appDefinition.name,
    { runtimeContext: effectiveRouteContext },
  );

  if (exported?.__aegisType === ROUTE_DEFINITION) {
    await exported.register(routeApi, EMPTY_ROUTE_CONTEXT);
  } else if (exported && typeof exported === 'object' && typeof exported.register === 'function') {
    await exported.register(routeApi, EMPTY_ROUTE_CONTEXT);
  } else if (typeof exported === 'function') {
    const result = await exported(routeApi, EMPTY_ROUTE_CONTEXT);
    if (isRouterInstance(result)) {
      expressApp.use(appDefinition.mount, result);
      return;
    }
  } else if (isRouterInstance(exported)) {
    expressApp.use(appDefinition.mount, exported);
    return;
  } else {
    throw new Error(`Unsupported routes export for app ${appDefinition.name}`);
  }

  expressApp.use(appDefinition.mount, router);
}

async function loadProjectRoutes(rootDir) {
  const routesFile = exists(path.join(rootDir, 'routes.js'))
    ? path.join(rootDir, 'routes.js')
    : path.join(rootDir, 'routes', 'index.js');

  if (!exists(routesFile)) {
    return null;
  }

  const loaded = await importModule(routesFile);
  const exported = loaded.default ?? loaded;

  if (exported?.__aegisType === PROJECT_ROUTE_DEFINITION) {
    return {
      ...exported,
      sourceFile: routesFile,
    };
  }

  if (exported?.__aegisType === ROUTE_DEFINITION) {
    return {
      __aegisType: PROJECT_ROUTE_DEFINITION,
      apps: [],
      routes: exported.register,
      sourceFile: routesFile,
    };
  }

  if (typeof exported === 'function') {
    return {
      __aegisType: PROJECT_ROUTE_DEFINITION,
      apps: [],
      routes: exported,
      sourceFile: routesFile,
    };
  }

  if (exported && typeof exported === 'object' && typeof exported.register === 'function') {
    return {
      __aegisType: PROJECT_ROUTE_DEFINITION,
      apps: [],
      routes: exported.register,
      sourceFile: routesFile,
    };
  }

  return null;
}

function configureTemplateEngine(expressApp, config, rootDir, logger) {
  const templateConfig = normalizeTemplatesConfig(config.templates, rootDir);
  config.templates = templateConfig;

  if (!templateConfig.enabled) {
    logger.info('Templates disabled by configuration.');
    return templateConfig;
  }

  expressApp.set('view engine', templateConfig.engine);
  expressApp.set('views', templateConfig.root);

  logger.debug(
    'Templates configured: engine=%s dir=%s base=%s',
    templateConfig.engine,
    templateConfig.root,
    templateConfig.base || '(none)',
  );

  if (!exists(templateConfig.root)) {
    logger.debug('Template directory does not exist yet: %s', templateConfig.root);
  }

  return templateConfig;
}

function attachTemplateHelpers(expressApp, templateConfig, logger, runtimeHelpers = null) {
  if (!templateConfig?.enabled) {
    return;
  }

  const helperSet = isPlainObject(runtimeHelpers?.helpers) ? runtimeHelpers.helpers : {};
  const jliveBridge = runtimeHelpers?.jlive || null;
  const runtimeEnv = isPlainObject(runtimeHelpers?.env) ? runtimeHelpers.env : {};
  const customLocalsSource = templateConfig?.locals;

  expressApp.use((req, res, next) => {
    let customLocals = {};
    try {
      if (typeof customLocalsSource === 'function') {
        const computed = customLocalsSource({
          req,
          res,
          helpers: helperSet,
          jlive: jliveBridge,
          env: runtimeEnv,
        });
        customLocals = isPlainObject(computed) ? computed : {};
      } else if (isPlainObject(customLocalsSource)) {
        customLocals = customLocalsSource;
      }
    } catch (error) {
      logger.error('templates.locals resolver failed: %s', error?.message || String(error));
      customLocals = {};
    }

    for (const [key, value] of Object.entries(customLocals)) {
      if (!Object.prototype.hasOwnProperty.call(res.locals, key)) {
        res.locals[key] = value;
      }
    }

    res.locals.helpers = res.locals.helpers || helperSet;
    res.locals.jlive = res.locals.jlive || jliveBridge;

    if (!Object.prototype.hasOwnProperty.call(res.locals, 'locale') && typeof req.aegis?.locale === 'string') {
      res.locals.locale = req.aegis.locale;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 'i18n') && req.aegis?.i18n) {
      res.locals.i18n = req.aegis.i18n;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 't') && typeof req.aegis?.t === 'function') {
      res.locals.t = req.aegis.t;
    }

    if (!Object.prototype.hasOwnProperty.call(res.locals, 'money') && typeof helperSet.money === 'function') {
      res.locals.money = helperSet.money;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 'number') && typeof helperSet.number === 'function') {
      res.locals.number = helperSet.number;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 'dateTime') && typeof helperSet.dateTime === 'function') {
      res.locals.dateTime = helperSet.dateTime;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 'timeElapsed') && typeof helperSet.timeElapsed === 'function') {
      res.locals.timeElapsed = helperSet.timeElapsed;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 'timeDifference') && typeof helperSet.timeDifference === 'function') {
      res.locals.timeDifference = helperSet.timeDifference;
    }
    if (!Object.prototype.hasOwnProperty.call(res.locals, 'breakStr') && typeof helperSet.breakStr === 'function') {
      res.locals.breakStr = helperSet.breakStr;
    }

    res.render = (viewName, localsOrCallback, maybeCallback) => {
      let callback = null;
      let providedLocals = {};

      if (typeof localsOrCallback === 'function') {
        callback = localsOrCallback;
      } else if (localsOrCallback === undefined || localsOrCallback === null) {
        providedLocals = {};
      } else if (typeof localsOrCallback === 'object') {
        providedLocals = localsOrCallback;
      } else {
        const error = new Error('res.render locals must be an object.');
        if (typeof maybeCallback === 'function') {
          maybeCallback(error);
          return res;
        }
        throw error;
      }

      if (typeof maybeCallback === 'function') {
        callback = maybeCallback;
      }

      const renderPage = async () => {
        const pageTemplate = normalizeTemplateName(viewName, 'view');
        const scopedLocals = {
          ...res.locals,
          ...providedLocals,
        };

        const layoutOverride = Object.prototype.hasOwnProperty.call(providedLocals, 'layout')
          ? providedLocals.layout
          : undefined;

        delete scopedLocals.layout;

        const appScopedLayout = (() => {
          const appName = typeof req?.aegis?.appName === 'string' ? req.aegis.appName.trim() : '';
          if (!appName || !isPlainObject(templateConfig.appBases)) {
            return undefined;
          }

          if (!Object.prototype.hasOwnProperty.call(templateConfig.appBases, appName)) {
            return undefined;
          }

          return templateConfig.appBases[appName];
        })();

        const requestedLayout = layoutOverride === false || layoutOverride === null
          ? null
          : (typeof layoutOverride === 'string' && layoutOverride.trim().length > 0
              ? normalizeTemplateName(layoutOverride, 'layout')
              : (appScopedLayout === null
                  ? null
                  : (typeof appScopedLayout === 'string' && appScopedLayout.length > 0
                      ? normalizeTemplateName(appScopedLayout, 'app layout')
                      : templateConfig.base)));

        const body = await renderTemplateFile({
          templatesRoot: templateConfig.root,
          templateName: pageTemplate,
          locals: scopedLocals,
        });

        if (!requestedLayout) {
          return body;
        }

        const layoutLocals = {
          ...scopedLocals,
          body,
          content: body,
          pageTemplate,
        };

        return renderTemplateFile({
          templatesRoot: templateConfig.root,
          templateName: requestedLayout,
          locals: layoutLocals,
        });
      };

      if (callback) {
        renderPage()
          .then((html) => callback(null, html))
          .catch((error) => callback(error));
        return res;
      }

      return renderPage()
        .then((html) => {
          if (!res.headersSent) {
            res.type('html').send(html);
          }
          return res;
        })
        .catch((error) => {
          logger.error('Template render failed for "%s": %s', String(viewName), error?.message || String(error));
          if (!res.headersSent) {
            res.status(500).json({ error: 'Template render error' });
          }
          return res;
        });
    };

    next();
  });
}

function buildContext({
  rootDir,
  config,
  env = {},
  i18n = null,
  logger,
  container,
  events,
  expressApp,
  server,
  io,
  database,
  cache,
  templates,
  auth = null,
  helpers = {},
  jlive = null,
  upload = null,
  protocol = 'http',
}) {
  return {
    rootDir,
    config,
    env,
    i18n,
    logger,
    container,
    events,
    app: expressApp,
    server,
    io,
    database,
    dbClient: database?.client ?? null,
    cache,
    templates,
    auth,
    helpers,
    jlive,
    upload,
    protocol,
    declaredAppNames: new Set(),
  };
}

function attachDefaultMiddlewares(expressApp, config, rootDir) {
  expressApp.use(express.json({ limit: '2mb' }));
  expressApp.use(express.urlencoded({ extended: true }));

  if (typeof config.staticDir === 'string' && config.staticDir.trim().length > 0) {
    const staticPath = path.join(rootDir, config.staticDir);
    expressApp.use(express.static(staticPath));
  }
}

function attachSecurityMiddlewares(expressApp, config, logger) {
  if (!isPlainObject(config.security)) {
    config.security = {};
  }

  const headersConfig = normalizeSecurityHeadersConfig(config.security);
  config.security.headers = headersConfig;

  if (!headersConfig.enabled) {
    logger.info('Security headers disabled by configuration.');
    return;
  }

  const helmetOptions = {};

  if (headersConfig.csp.enabled) {
    helmetOptions.contentSecurityPolicy = {
      useDefaults: true,
      directives: buildCspDirectives(headersConfig.csp.directives),
      reportOnly: headersConfig.csp.reportOnly,
    };
  } else {
    helmetOptions.contentSecurityPolicy = false;
  }

  expressApp.use(helmet(helmetOptions));
  logger.debug(
    'Security headers middleware enabled. CSP=%s',
    headersConfig.csp.enabled ? 'on' : 'off',
  );
}

function attachDdosProtection(expressApp, config, logger) {
  if (!isPlainObject(config.security)) {
    config.security = {};
  }

  const ddosConfig = normalizeDdosConfig(config.security);
  config.security.ddos = ddosConfig;

  if (!ddosConfig.enabled) {
    logger.info('DDoS rate limiter disabled by configuration.');
    return;
  }

  const limiter = rateLimit({
    windowMs: ddosConfig.windowMs,
    limit: ddosConfig.maxRequests,
    standardHeaders: ddosConfig.standardHeaders,
    legacyHeaders: ddosConfig.legacyHeaders,
    skipSuccessfulRequests: ddosConfig.skipSuccessfulRequests,
    skipFailedRequests: ddosConfig.skipFailedRequests,
    statusCode: ddosConfig.statusCode,
    message: { error: ddosConfig.message },
    store: ddosConfig.store || undefined,
    skip: (req) => {
      const requestPath = String(req.path || req.originalUrl || '/');
      return ddosConfig.skipPaths.some((prefix) => {
        if (prefix === '/') {
          return requestPath === '/';
        }
        return requestPath === prefix || requestPath.startsWith(`${prefix}/`);
      });
    },
  });

  expressApp.use(limiter);
  logger.debug(
    'DDoS rate limiter enabled: max=%s windowMs=%s',
    ddosConfig.maxRequests,
    ddosConfig.windowMs,
  );
}

function attachCsrfProtection(expressApp, config, logger, auth = null) {
  if (!isPlainObject(config.security)) {
    config.security = {};
  }

  const csrfConfig = normalizeCsrfConfig(config.security);
  config.security.csrf = csrfConfig;
  const appSecret = resolveAppSecret(config.security);

  if (!csrfConfig.enabled) {
    logger.info('CSRF protection disabled by configuration.');
    return;
  }

  if (!appSecret && csrfConfig.requireSignedCookie) {
    throw new Error('CSRF protection requires a strong security.appSecret (min length 16) to sign CSRF cookies. Set security.appSecret or set security.csrf.requireSignedCookie=false (not recommended).');
  }

  if (!appSecret) {
    logger.warn('security.appSecret is missing or too short: CSRF cookie signing is disabled. Set a strong appSecret in settings.js.');
  }

  expressApp.use((req, res, next) => {
    if (config.api?.disableCsrf === true && req.aegis?.isApiRequest === true) {
      return next();
    }

    if (
      auth
      && auth.provider === 'oauth2'
      && auth.oauth2Server?.enabled === true
      && typeof auth.isOAuthServerRequestPath === 'function'
      && auth.isOAuthServerRequestPath(String(req.path || req.originalUrl || '/'))
    ) {
      return next();
    }

    const cookies = parseCookies(req.headers?.cookie);
    const parsed = decodeCsrfCookieValue(cookies[csrfConfig.cookieName], appSecret);
    let token = parsed.valid ? parsed.token : '';
    let shouldSetCookie = false;

    if (typeof token !== 'string' || token.length < 32) {
      token = crypto.randomBytes(32).toString('hex');
      shouldSetCookie = true;
    }

    if (shouldSetCookie) {
      res.cookie(csrfConfig.cookieName, encodeCsrfCookieValue(token, appSecret), {
        encode: (value) => value,
        httpOnly: csrfConfig.httpOnly,
        sameSite: csrfConfig.sameSite,
        secure: resolveSecureCookieFlag(req, csrfConfig.secure),
        path: csrfConfig.path,
      });
    }

    req.csrfToken = () => token;
    res.locals.csrfValue = token;
    res.locals.csrfToken = markRawHtml(
      `<input type="hidden" name="${ejs.escapeXML(csrfConfig.fieldName)}" value="${ejs.escapeXML(token)}" />`,
    );

    const unsafeMethod = !isSafeHttpMethod(req.method);
    const shouldValidate = unsafeMethod && (
      csrfConfig.rejectUnsafeMethods
      || (csrfConfig.rejectForms && isFormSubmissionRequest(req))
    );

    if (!shouldValidate) {
      return next();
    }

    const provided = extractCsrfToken(req, csrfConfig);
    if (!provided || !constantTimeEqual(provided, token)) {
      return res.status(403).json({ error: 'CSRF token missing or invalid' });
    }

    return next();
  });

  logger.debug('CSRF protection middleware enabled for unsafe requests.');
}

function attachApiMiddlewares(expressApp, config, declaredApps, logger) {
  const apiConfig = normalizeApiConfig(config.api, declaredApps || config.apps || []);
  config.api = apiConfig;
  const uploadsConfig = config.uploads && typeof config.uploads === 'object' ? config.uploads : null;
  const allowApiMultipart = uploadsConfig?.enabled !== false && uploadsConfig?.allowApiMultipart === true;

  if (!Array.isArray(apiConfig.mounts) || apiConfig.mounts.length === 0) {
    logger.debug('API app middleware disabled: no API apps configured.');
    return;
  }

  expressApp.use((req, res, next) => {
    const requestPath = String(req.path || req.originalUrl || '/');
    const isApiRequest = apiConfig.mounts.some((mount) => requestPathMatchesPrefix(requestPath, mount));

    req.aegis = req.aegis || {};
    req.aegis.isApiRequest = isApiRequest;

    if (!isApiRequest) {
      return next();
    }

    if (apiConfig.noStoreHeaders) {
      res.setHeader('Cache-Control', 'no-store');
    }

    if (
      apiConfig.requireJsonForUnsafeMethods
      && !isSafeHttpMethod(req.method)
      && hasRequestBody(req)
      && !(allowApiMultipart && isMultipartRequestContentType(req.headers?.['content-type']))
      && !isJsonRequestContentType(req.headers?.['content-type'])
    ) {
      return res.status(415).json({
        error: 'API endpoints accept application/json payloads only',
      });
    }

    return next();
  });

  logger.debug('API middleware enabled for mounts: %s', apiConfig.mounts.join(', '));
}

function attachOAuth2AuthorizationServer(expressApp, auth, logger) {
  if (!auth || auth.provider !== 'oauth2' || auth.oauth2Server?.enabled !== true) {
    logger.debug('OAuth2 authorization server endpoints disabled.');
    return;
  }

  const handlers = auth.oauth2Server.handlers || {};
  const paths = auth.oauth2Server.paths || {};
  if (
    typeof handlers.metadata !== 'function'
    || typeof handlers.authorize !== 'function'
    || typeof handlers.token !== 'function'
    || typeof handlers.introspect !== 'function'
    || typeof handlers.revoke !== 'function'
    || typeof paths.metadata !== 'string'
    || typeof paths.authorize !== 'string'
    || typeof paths.token !== 'string'
    || typeof paths.introspect !== 'string'
    || typeof paths.revoke !== 'string'
  ) {
    logger.warn('OAuth2 authorization server handlers are incomplete. Endpoints were not mounted.');
    return;
  }

  expressApp.get(paths.metadata, handlers.metadata);
  expressApp.get(paths.authorize, handlers.authorize);
  expressApp.post(paths.authorize, handlers.authorize);
  expressApp.post(paths.token, handlers.token);
  expressApp.post(paths.introspect, handlers.introspect);
  expressApp.post(paths.revoke, handlers.revoke);

  logger.info(
    'OAuth2 authorization server mounted (authorize=%s token=%s introspect=%s revoke=%s metadata=%s)',
    paths.authorize,
    paths.token,
    paths.introspect,
    paths.revoke,
    paths.metadata,
  );
}

function buildDefaultSwaggerDocument(config) {
  const protocol = resolveServerProtocol(config);
  return {
    openapi: '3.0.3',
    info: {
      title: `${config.appName || 'AegisNode'} API`,
      version: '1.0.0',
      description: 'Default OpenAPI document generated by AegisNode.',
    },
    servers: [
      {
        url: `${protocol}://${config.host || '0.0.0.0'}:${config.port || 3000}`,
      },
    ],
    paths: {},
  };
}

async function loadSwaggerDocumentFromFile(swaggerConfig, rootDir, logger) {
  const sourcePath = path.isAbsolute(swaggerConfig.documentPath)
    ? swaggerConfig.documentPath
    : path.join(rootDir, swaggerConfig.documentPath);

  if (!exists(sourcePath)) {
    return null;
  }

  try {
    const raw = await fsPromises.readFile(sourcePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error('OpenAPI document must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    logger.warn('Swagger document parsing failed at %s: %s', sourcePath, error?.message || String(error));
    return null;
  }
}

async function attachSwaggerMiddlewares(expressApp, config, rootDir, logger) {
  const swaggerConfig = normalizeSwaggerConfig(config.swagger);
  config.swagger = swaggerConfig;

  if (!swaggerConfig.enabled) {
    logger.debug('Swagger UI disabled by configuration.');
    return;
  }

  const loadedDocument = swaggerConfig.document
    || await loadSwaggerDocumentFromFile(swaggerConfig, rootDir, logger)
    || buildDefaultSwaggerDocument(config);
  config.swagger.document = loadedDocument;

  expressApp.get(swaggerConfig.jsonPath, (req, res) => {
    res.json(loadedDocument);
  });

  expressApp.use(
    swaggerConfig.docsPath,
    swaggerUi.serve,
    swaggerUi.setup(loadedDocument, {
      explorer: swaggerConfig.explorer,
    }),
  );

  logger.info('Swagger UI mounted at %s (OpenAPI JSON: %s)', swaggerConfig.docsPath, swaggerConfig.jsonPath);
}

function attachErrorHandlers(expressApp, logger) {
  expressApp.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  expressApp.use((error, req, res, next) => {
    logger.error(error?.stack || error?.message || String(error));

    if (res.headersSent) {
      return next(error);
    }

    return res.status(error?.statusCode || 500).json({
      error: 'Internal Server Error',
    });
  });
}

function attachSocketLifecycle(io, events) {
  if (!io) {
    return;
  }

  io.on('connection', (socket) => {
    events.publish('ws.connection', { socket });

    socket.on('disconnect', (reason) => {
      events.publish('ws.disconnect', { socket, reason });
    });
  });
}

export async function createKernel({ rootDir = process.cwd(), overrides = {} } = {}) {
  const loadedConfig = await loadProjectConfig(rootDir);
  const config = deepMerge(loadedConfig, overrides || {});
  config.rootDir = rootDir;
  const logger = createLogger({ level: config.logging?.level, name: config.appName || 'aegisnode' });
  const resolvedAppSecret = ensureAppSecret(config, rootDir, logger);
  config.apps = normalizeApps(config.apps || []);
  config.api = normalizeApiConfig(config.api, config.apps);
  config.auth = normalizeAuthConfig(config.auth, {
    appName: config.appName || path.basename(rootDir),
    appSecret: resolvedAppSecret,
  });
  config.swagger = normalizeSwaggerConfig(config.swagger);
  config.architecture = normalizeArchitectureConfig(config.architecture);
  config.uploads = normalizeUploadsConfig(config.uploads, rootDir);

  const runtimeEnv = Object.freeze({
    ...process.env,
    APP_SECRET: process.env.APP_SECRET || config.security?.appSecret || '',
  });
  const defaultInstallTemplate = await loadDefaultInstallTemplate(logger);
  const runtimeHelpers = await createRuntimeHelpers({ logger, config });
  const i18nConfig = normalizeI18nConfig(config.i18n, rootDir, logger);
  config.i18n = i18nConfig;
  const runtimeI18n = createRuntimeI18n(i18nConfig);
  const upload = await createUploadManager(config.uploads, logger);
  const container = createContainer();
  const events = createEventBus();
  const expressApp = express();
  const templateConfig = configureTemplateEngine(expressApp, config, rootDir, logger);
  applyTrustProxySetting(expressApp, config, logger);
  const websocketCorsConfig = Object.prototype.hasOwnProperty.call(config.websocket || {}, 'cors')
    ? config.websocket.cors
    : { origin: false };
  const { server, protocol: serverProtocol } = createHttpServer(expressApp, config);
  const io = config.websocket?.enabled === false
    ? null
    : new SocketIOServer(server, {
        cors: websocketCorsConfig ?? { origin: false },
      });

  const database = await initializeDatabase(config.database, logger);
  const cache = createCache(config.cache, logger);
  const auth = createAuthManager({
    config: config.auth,
    cache,
    logger,
    rootDir,
    database,
  });
  if (auth?.ready && typeof auth.ready.then === 'function') {
    await auth.ready;
  }

  container.set('config', config);
  container.set('env', runtimeEnv);
  container.set('logger', logger);
  container.set('events', events);
  container.set('app', expressApp);
  container.set('server', server);
  container.set('protocol', serverProtocol);
  container.set('io', io);
  container.set('database', database);
  container.set('dbClient', database?.client ?? null);
  container.set('cache', cache);
  container.set('auth', auth);
  container.set('templates', templateConfig);
  container.set('helpers', runtimeHelpers.helpers);
  container.set('jlive', runtimeHelpers.jlive);
  container.set('i18n', runtimeI18n);
  container.set('upload', upload);

  const context = buildContext({
    rootDir,
    config,
    env: runtimeEnv,
    i18n: runtimeI18n,
    logger,
    container,
    events,
    expressApp,
    server,
    io,
    database,
    cache,
    templates: templateConfig,
    auth,
    helpers: runtimeHelpers.helpers,
    jlive: runtimeHelpers.jlive,
    upload,
    protocol: serverProtocol,
  });
  const layerAccessors = createLayerAccessors({ container, context });
  context.services = layerAccessors.services;
  context.models = layerAccessors.models;
  context.validators = layerAccessors.validators;
  container.set('services', layerAccessors.services);
  container.set('models', layerAccessors.models);
  container.set('validators', layerAccessors.validators);
  const strictLayers = config.architecture.strictLayers === true;

  await runLoaders(config.loaders, context, rootDir, logger);

  const projectRoutes = await loadProjectRoutes(rootDir);
  if (strictLayers) {
    await enforceStrictProjectRoutes(projectRoutes?.sourceFile || path.join(rootDir, 'routes.js'));
  }
  const settingsDeclaredApps = normalizeApps(config.apps || []);
  const settingsDeclaredAppNames = new Set(settingsDeclaredApps.map((entry) => entry.name));

  if (projectRoutes?.apps?.length) {
    const projectDeclaredApps = normalizeApps(projectRoutes.apps);
    const unknownApps = projectDeclaredApps
      .map((entry) => entry.name)
      .filter((name) => !settingsDeclaredAppNames.has(name));

    if (unknownApps.length) {
      throw new Error(
        `Apps used in routes.js must be declared in settings.apps: ${unknownApps.join(', ')}`,
      );
    }
  }

  const declaredApps = settingsDeclaredApps;
  context.declaredAppNames = new Set(declaredApps.map((entry) => entry.name));
  config.api = normalizeApiConfig(config.api, declaredApps);

  attachSecurityMiddlewares(expressApp, config, logger);
  attachDdosProtection(expressApp, config, logger);
  attachDefaultMiddlewares(expressApp, config, rootDir);
  attachApiMiddlewares(expressApp, config, declaredApps, logger);
  attachRequestRuntimeBridge(expressApp, context);
  attachOAuth2AuthorizationServer(expressApp, auth, logger);
  attachCsrfProtection(expressApp, config, logger, auth);
  await attachSwaggerMiddlewares(expressApp, config, rootDir, logger);
  attachTemplateHelpers(expressApp, templateConfig, logger, {
    ...runtimeHelpers,
    env: runtimeEnv,
  });
  attachSocketLifecycle(io, events);

  for (const appDefinition of declaredApps) {
    const appRoot = path.join(rootDir, 'apps', appDefinition.name);
    if (!exists(appRoot)) {
      throw new Error(`App not found: ${appRoot}`);
    }

    if (strictLayers) {
      await enforceStrictLayerArchitecture({
        appName: appDefinition.name,
        appRoot,
      });
    }

    await registerControllers({
      appName: appDefinition.name,
      appRoot,
      container,
      logger,
    });

    await registerModels({
      appName: appDefinition.name,
      appRoot,
      container,
      logger,
    });

    await registerValidators({
      appName: appDefinition.name,
      appRoot,
      container,
      logger,
    });

    await registerServices({
      appName: appDefinition.name,
      appRoot,
      container,
      logger,
    });

    const appRouteContext = buildRouteRuntimeContext({
      context,
      layerAccessors,
      strictLayers,
      appDefinition,
    });

    await registerSubscribers({
      appName: appDefinition.name,
      appRoot,
      context: {
        ...context,
        services: layerAccessors.servicesForApp(appDefinition.name),
        models: layerAccessors.modelsForApp(appDefinition.name),
        validators: layerAccessors.validatorsForApp(appDefinition.name),
      },
      logger,
    });

    const appAutoMounted = config.autoMountApps === true;
    if (appAutoMounted) {
      await mountAppRoutes({
        appDefinition,
        appRoot,
        context,
        expressApp,
        routeContext: appRouteContext,
      });
    }

    events.publish('app.booted', {
      appName: appDefinition.name,
      mount: appDefinition.mount,
    });

    if (appAutoMounted) {
      logger.info('App mounted: %s at %s', appDefinition.name, appDefinition.mount);
    } else {
      logger.info('App loaded: %s (central routes.js controls HTTP routes)', appDefinition.name);
    }
  }

  const rootRouter = express.Router();
  const projectRouteState = { hasAny: false, hasRootGet: false };
  const projectRouteContext = buildRouteRuntimeContext({
    context,
    layerAccessors,
    strictLayers,
    appDefinition: null,
  });
  const routeApi = createRouteApi(
    rootRouter,
    (reference, currentApp, runtimeContext) => resolveControllerReference(reference, {
      container,
      currentApp,
      runtimeContext,
    }),
    null,
    { routeState: projectRouteState, runtimeContext: projectRouteContext },
  );

  if (projectRoutes?.routes) {
    await projectRoutes.routes(routeApi, EMPTY_ROUTE_CONTEXT);
    logger.info('Project routes mounted.');
  }

  if (!projectRouteState.hasRootGet) {
    rootRouter.get('/', (req, res) => {
      try {
        const html = renderDefaultInstallPage(defaultInstallTemplate, config);
        res.type('html').send(html);
      } catch (error) {
        logger.error('Default confirmation page render failed: %s', error?.message || String(error));
        res.status(500).json({ error: 'Template render error' });
      }
    });
    logger.info('Default confirmation page mounted at /.');
  } else {
    logger.info('Custom root route detected in routes.js; default confirmation page skipped.');
  }

  if (projectRoutes?.routes || !projectRouteState.hasRootGet) {
    expressApp.use('/', rootRouter);
  }

  attachErrorHandlers(expressApp, logger);

  let started = false;

  return {
    config,
    context,
    start: () => new Promise((resolve, reject) => {
      if (started) {
        resolve();
        return;
      }

      server.listen(config.port, config.host, () => {
        started = true;
        logger.info('AegisNode server running at %s://%s:%s', serverProtocol, config.host, config.port);
        resolve();
      });

      server.once('error', (error) => {
        reject(error);
      });
    }),
    stop: async () => {
      if (io) {
        await new Promise((resolve) => io.close(() => resolve()));
      }

      if (!server.listening) {
        if (auth && typeof auth.close === 'function') {
          await auth.close();
        }
        await closeDatabase(database);
        events.removeAll();
        logger.info('AegisNode server stopped.');
        return;
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            if (error.code === 'ERR_SERVER_NOT_RUNNING') {
              resolve();
              return;
            }
            reject(error);
            return;
          }
          resolve();
        });
      });

      if (auth && typeof auth.close === 'function') {
        await auth.close();
      }
      await closeDatabase(database);
      events.removeAll();
      logger.info('AegisNode server stopped.');
    },
  };
}

export async function runProject({ rootDir = process.cwd(), overrides = {} } = {}) {
  const kernel = await createKernel({ rootDir, overrides });
  await kernel.start();
  return kernel;
}

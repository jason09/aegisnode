import fs from 'fs/promises';
import path from 'path';
import { loadProjectConfig } from '../../runtime/config.js';
import { resolveProjectRoot } from '../utils/project.js';

function createCollector() {
  const entries = [];
  return {
    entries,
    ok: (message) => entries.push({ level: 'OK', message }),
    warn: (message) => entries.push({ level: 'WARN', message }),
    error: (message) => entries.push({ level: 'ERROR', message }),
  };
}

function hasStrongSecret(value) {
  return typeof value === 'string' && value.trim().length >= 16;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runAppChecks(rootDir, config, collector) {
  const apps = Array.isArray(config.apps) ? config.apps : [];

  if (apps.length === 0) {
    collector.warn('No apps declared in settings.apps.');
    return;
  }

  collector.ok(`Declared apps: ${apps.map((app) => app.name).join(', ')}`);

  for (const app of apps) {
    const appName = app?.name;
    const mount = app?.mount;
    if (typeof appName !== 'string' || appName.trim().length === 0) {
      collector.error(`Invalid app entry: ${JSON.stringify(app)}`);
      continue;
    }

    if (typeof mount !== 'string' || !mount.startsWith('/')) {
      collector.error(`App "${appName}" has invalid mount "${String(mount)}" (must start with /).`);
    }

    const appRoot = path.join(rootDir, 'apps', appName);
    const appRootExists = await fileExists(appRoot);
    if (!appRootExists) {
      collector.error(`App directory missing: apps/${appName}`);
      continue;
    }

    const requiredFiles = ['routes.js', 'views.js', 'services.js', 'models.js', 'validators.js'];
    for (const fileName of requiredFiles) {
      const target = path.join(appRoot, fileName);
      if (!(await fileExists(target))) {
        collector.warn(`App "${appName}" missing ${fileName}.`);
      }
    }

    const subscribersFile = path.join(appRoot, 'subscribers.js');
    if (!(await fileExists(subscribersFile))) {
      collector.warn(`App "${appName}" missing subscribers.js.`);
    }
  }
}

async function runStartupEntryChecks(rootDir, config, collector) {
  const env = String(config.env || process.env.NODE_ENV || 'development').trim().toLowerCase();
  const appEntryPath = path.join(rootDir, 'app.js');
  const loaderEntryPath = path.join(rootDir, 'loader.cjs');
  const appEntryExists = await fileExists(appEntryPath);
  const loaderEntryExists = await fileExists(loaderEntryPath);

  if (appEntryExists) {
    collector.ok('app.js exists.');
  } else if (env === 'production') {
    collector.error('app.js is missing for production startup. Run "aegisnode generateloader" to restore startup entry files.');
  } else {
    collector.warn('app.js is missing. Run "aegisnode generateloader" to restore startup entry files.');
  }

  if (loaderEntryExists) {
    collector.ok('loader.cjs exists.');
  } else if (env === 'production') {
    collector.error('loader.cjs is missing for production startup. Run "aegisnode generateloader" to restore it.');
  } else {
    collector.warn('loader.cjs is missing. Generate it with "aegisnode generateloader" before non-development startup.');
  }
}

function runSecurityChecks(config, collector) {
  const env = String(config.env || process.env.NODE_ENV || 'development');
  const security = config.security || {};

  if (!hasStrongSecret(security.appSecret)) {
    if (env === 'production') {
      collector.error('security.appSecret is missing/weak for production (min length: 16).');
    } else {
      collector.warn('security.appSecret is missing/weak (recommended min length: 16).');
    }
  } else {
    collector.ok('security.appSecret is set.');
  }

  if (security?.headers?.enabled === false) {
    collector.warn('security.headers.enabled is false.');
  }
  if (security?.csrf?.enabled === false) {
    collector.warn('security.csrf.enabled is false.');
  }
  if (security?.ddos?.enabled === false) {
    collector.warn('security.ddos.enabled is false.');
  }
}

function runAuthChecks(config, collector) {
  const auth = config.auth || {};
  if (auth.enabled !== true) {
    collector.ok('Auth subsystem disabled.');
    return;
  }

  collector.ok(`Auth subsystem enabled (${auth.provider || 'jwt'}).`);

  if (auth.provider === 'jwt') {
    const jwtSecret = auth?.jwt?.secret;
    const appSecret = config?.security?.appSecret;
    if (!hasStrongSecret(jwtSecret) && !hasStrongSecret(appSecret)) {
      collector.error('JWT enabled but neither auth.jwt.secret nor security.appSecret is strong.');
    }
  }

  if (auth.provider === 'oauth2' && config.env === 'production') {
    if (auth?.oauth2?.server?.allowHttp === true) {
      collector.error('OAuth2 server allowHttp=true in production.');
    }
  }
}

function runApiChecks(config, collector) {
  const apiApps = Array.isArray(config?.api?.apps) ? config.api.apps : [];
  const appNames = new Set((Array.isArray(config.apps) ? config.apps : []).map((app) => app.name));

  for (const apiAppName of apiApps) {
    if (!appNames.has(apiAppName)) {
      collector.warn(`api.apps references unknown app "${apiAppName}".`);
    }
  }
}

async function runTemplateChecks(rootDir, config, collector) {
  const templates = config.templates || {};
  if (templates.enabled === false) {
    collector.ok('Templates disabled.');
    return;
  }

  const templatesDir = typeof templates.dir === 'string' && templates.dir.trim().length > 0
    ? templates.dir.trim()
    : 'templates';
  const templatesRoot = path.isAbsolute(templatesDir)
    ? templatesDir
    : path.join(rootDir, templatesDir);

  if (!(await fileExists(templatesRoot))) {
    collector.warn(`Template directory does not exist: ${templatesRoot}`);
  } else {
    collector.ok(`Template directory exists: ${templatesRoot}`);
  }
}

function printSummary(entries, output = console) {
  for (const entry of entries) {
    output.log(`[${entry.level}] ${entry.message}`);
  }

  const errors = entries.filter((item) => item.level === 'ERROR').length;
  const warnings = entries.filter((item) => item.level === 'WARN').length;
  const oks = entries.filter((item) => item.level === 'OK').length;

  output.log('');
  output.log(`Doctor summary: ${errors} error(s), ${warnings} warning(s), ${oks} ok.`);
  return { errors, warnings, oks };
}

export async function runDoctor({
  projectRoot,
  failOnError = true,
  output = console,
} = {}) {
  const resolvedRoot = await resolveProjectRoot(projectRoot || process.cwd());
  const collector = createCollector();

  collector.ok(`Project root: ${resolvedRoot}`);

  const config = await loadProjectConfig(resolvedRoot);
  collector.ok(`Environment: ${config.env || 'development'}`);

  await runAppChecks(resolvedRoot, config, collector);
  await runStartupEntryChecks(resolvedRoot, config, collector);
  runSecurityChecks(config, collector);
  runAuthChecks(config, collector);
  runApiChecks(config, collector);
  await runTemplateChecks(resolvedRoot, config, collector);

  const summary = printSummary(collector.entries, output);

  if (failOnError && summary.errors > 0) {
    throw new Error('Doctor failed with configuration errors.');
  }

  return {
    rootDir: resolvedRoot,
    config,
    entries: collector.entries,
    summary,
  };
}

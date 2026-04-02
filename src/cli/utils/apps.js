import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { ensureDir, ensureValidName, exists, normalizeMountPath, writeFile } from './fs.js';
import {
  renderAppModelTest,
  renderAppModelsFile,
  renderAppRoutes,
  renderAppRoutesTest,
  renderAppServiceTest,
  renderAppServicesFile,
  renderAppSubscribersFile,
  renderAppUtilsFile,
  renderAppValidatorTest,
  renderAppValidatorsFile,
  renderAppViewsFile,
  renderSettingsApps,
} from './scaffolds.js';

export const APPS_START = '// AEGIS_APPS_START';
export const APPS_END = '// AEGIS_APPS_END';

function renderAppEntries(apps) {
  return apps
    .map((app) => `    { name: ${JSON.stringify(app.name)}, mount: ${JSON.stringify(app.mount)} },`)
    .join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toImportName(appName) {
  const safe = appName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  if (!safe) {
    return 'appRoutes';
  }

  return `${safe.charAt(0).toLowerCase()}${safe.slice(1)}`;
}

async function readDefaultExport(filePath) {
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const loaded = await import(moduleUrl);
  return loaded?.default;
}

export async function detectSettingsMode(projectRoot) {
  const single = path.join(projectRoot, 'settings.js');
  const split = path.join(projectRoot, 'settings', 'apps.js');

  if (await exists(single)) {
    return { mode: 'single', file: single };
  }

  if (await exists(split)) {
    return { mode: 'split', file: split };
  }

  throw new Error(`Not an AegisNode project root: missing ${single} (or legacy ${split})`);
}

export async function readAppsConfig(settingsMode) {
  const normalizeApp = (entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      return null;
    }

    ensureValidName(entry.name, 'app');
    return {
      name: entry.name,
      mount: normalizeMountPath(entry.mount || `/${entry.name}`),
    };
  };

  if (settingsMode.mode === 'single') {
    const settings = await readDefaultExport(settingsMode.file);
    const apps = settings?.apps;

    if (!Array.isArray(apps)) {
      throw new Error(`settings.js must export { apps: [] }. File: ${settingsMode.file}`);
    }

    return apps.map(normalizeApp).filter(Boolean);
  }

  const apps = await readDefaultExport(settingsMode.file);
  if (!Array.isArray(apps)) {
    throw new Error(`settings/apps.js must export an array. File: ${settingsMode.file}`);
  }

  return apps.map(normalizeApp).filter(Boolean);
}

async function updateSingleSettingsApps(settingsFile, apps) {
  const current = await fs.readFile(settingsFile, 'utf8');

  if (!current.includes(APPS_START) || !current.includes(APPS_END)) {
    throw new Error(`settings.js is missing ${APPS_START}/${APPS_END} markers: ${settingsFile}`);
  }

  const replacement = `${APPS_START}\n${renderAppEntries(apps)}\n    ${APPS_END}`;
  const updated = current.replace(/\/\/ AEGIS_APPS_START[\s\S]*?\/\/ AEGIS_APPS_END/m, replacement);

  await writeFile(settingsFile, updated);
}

export async function updateAppRegistry(projectRoot, apps, settingsMode) {
  if (settingsMode.mode === 'single') {
    await updateSingleSettingsApps(settingsMode.file, apps);
    return;
  }

  await writeFile(path.join(projectRoot, 'settings', 'apps.js'), renderSettingsApps(apps));
}

export function getAppScaffoldEntries(appName) {
  const appRoot = path.join('apps', appName);
  return [
    {
      target: path.join(appRoot, 'views.js'),
      content: renderAppViewsFile(appName),
    },
    {
      target: path.join(appRoot, 'models.js'),
      content: renderAppModelsFile(appName),
    },
    {
      target: path.join(appRoot, 'validators.js'),
      content: renderAppValidatorsFile(appName),
    },
    {
      target: path.join(appRoot, 'services.js'),
      content: renderAppServicesFile(appName),
    },
    {
      target: path.join(appRoot, 'utils.js'),
      content: renderAppUtilsFile(),
    },
    {
      target: path.join(appRoot, 'subscribers.js'),
      content: renderAppSubscribersFile(appName),
    },
    {
      target: path.join(appRoot, 'routes.js'),
      content: renderAppRoutes(appName),
    },
    {
      target: path.join(appRoot, 'tests', 'models.test.js'),
      content: renderAppModelTest(appName),
    },
    {
      target: path.join(appRoot, 'tests', 'validators.test.js'),
      content: renderAppValidatorTest(appName),
    },
    {
      target: path.join(appRoot, 'tests', 'services.test.js'),
      content: renderAppServiceTest(appName),
    },
    {
      target: path.join(appRoot, 'tests', 'routes.test.js'),
      content: renderAppRoutesTest(appName),
    },
  ];
}

export async function ensureAppScaffold(projectRoot, appName, { overwrite = false } = {}) {
  ensureValidName(appName, 'app');

  const appRoot = path.join(projectRoot, 'apps', appName);
  await ensureDir(appRoot);
  await ensureDir(path.join(appRoot, 'tests'));

  const written = [];
  const skipped = [];

  for (const entry of getAppScaffoldEntries(appName)) {
    const target = path.join(projectRoot, entry.target);
    if (!overwrite && await exists(target)) {
      skipped.push(target);
      continue;
    }

    await writeFile(target, entry.content);
    written.push(target);
  }

  return {
    appRoot,
    written,
    skipped,
  };
}

export async function updateProjectRoutesFile(projectRoot, appName, mountPath) {
  const routesFile = path.join(projectRoot, 'routes.js');
  if (!(await exists(routesFile))) {
    // Keep backward compatibility for legacy projects that still use routes/index.js.
    return {
      routesFile,
      updatedImport: false,
      updatedRoute: false,
      skipped: true,
    };
  }

  const importName = toImportName(appName);
  const importLine = `import ${importName} from './apps/${appName}/routes.js';`;
  const routeLine = `    route.use(${JSON.stringify(mountPath)}, ${importName});`;
  const routePattern = new RegExp(`route\\.use\\([^\\n]*,\\s*${escapeRegExp(importName)}\\s*\\);`);

  let content = await fs.readFile(routesFile, 'utf8');
  let updatedImport = false;
  let updatedRoute = false;

  if (!content.includes(importLine)) {
    if (content.includes('// AEGIS_APP_IMPORTS_START') && content.includes('// AEGIS_APP_IMPORTS_END')) {
      content = content.replace('// AEGIS_APP_IMPORTS_END', `${importLine}\n// AEGIS_APP_IMPORTS_END`);
    } else {
      content = `${importLine}\n${content}`;
    }
    updatedImport = true;
  }

  if (!routePattern.test(content)) {
    if (content.includes('// AEGIS_PROJECT_APP_ROUTES_START') && content.includes('// AEGIS_PROJECT_APP_ROUTES_END')) {
      content = content.replace('    // AEGIS_PROJECT_APP_ROUTES_END', `${routeLine}\n    // AEGIS_PROJECT_APP_ROUTES_END`);
      updatedRoute = true;
    } else {
      const match = content.match(/register\s*\([^)]*\)\s*{[\s\S]*?\n\s*}/m);
      if (match) {
        content = content.replace(match[0], `${match[0]}\n${routeLine}`);
        updatedRoute = true;
      }
    }
  }

  if (updatedImport || updatedRoute) {
    await writeFile(routesFile, content);
  }

  return {
    routesFile,
    updatedImport,
    updatedRoute,
    skipped: false,
  };
}

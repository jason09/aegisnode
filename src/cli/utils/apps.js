import fs from 'fs/promises';
import path from 'path';
import { ensureDir, ensureValidName, exists, normalizeMountPath, writeFile } from './fs.js';
import { importProjectModule } from '../../runtime/typescript.js';
import {
  detectProjectSourceExtension,
  resolveSourceFile,
} from '../../utils/source-files.js';
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
  withSourceExtension,
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
  const loaded = await importProjectModule(filePath);
  return loaded?.default;
}

export async function detectSettingsMode(projectRoot) {
  const single = resolveSourceFile(path.join(projectRoot, 'settings'));
  const split = resolveSourceFile(path.join(projectRoot, 'settings', 'apps'));

  if (single && await exists(single)) {
    return { mode: 'single', file: single };
  }

  if (split && await exists(split)) {
    return { mode: 'split', file: split };
  }

  throw new Error(`Not an AegisNode project root: missing settings.js/settings.ts (or legacy settings/apps.js/settings/apps.ts)`);
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
  const sourceExtension = detectProjectSourceExtension(projectRoot);

  if (settingsMode.mode === 'single') {
    await updateSingleSettingsApps(settingsMode.file, apps);
    return;
  }

  await writeFile(path.join(projectRoot, 'settings', withSourceExtension('apps', sourceExtension)), renderSettingsApps(apps));
}

export function getAppScaffoldEntries(appName, sourceExtension = '.js') {
  const appRoot = path.join('apps', appName);
  return [
    {
      target: path.join(appRoot, withSourceExtension('views', sourceExtension)),
      content: renderAppViewsFile(appName, sourceExtension),
    },
    {
      target: path.join(appRoot, withSourceExtension('models', sourceExtension)),
      content: renderAppModelsFile(appName),
    },
    {
      target: path.join(appRoot, withSourceExtension('validators', sourceExtension)),
      content: renderAppValidatorsFile(appName),
    },
    {
      target: path.join(appRoot, withSourceExtension('services', sourceExtension)),
      content: renderAppServicesFile(appName),
    },
    {
      target: path.join(appRoot, withSourceExtension('utils', sourceExtension)),
      content: renderAppUtilsFile(),
    },
    {
      target: path.join(appRoot, withSourceExtension('subscribers', sourceExtension)),
      content: renderAppSubscribersFile(appName),
    },
    {
      target: path.join(appRoot, withSourceExtension('routes', sourceExtension)),
      content: renderAppRoutes(appName, sourceExtension),
    },
    {
      target: path.join(appRoot, 'tests', withSourceExtension('models.test', sourceExtension)),
      content: renderAppModelTest(appName, sourceExtension),
    },
    {
      target: path.join(appRoot, 'tests', withSourceExtension('validators.test', sourceExtension)),
      content: renderAppValidatorTest(appName, sourceExtension),
    },
    {
      target: path.join(appRoot, 'tests', withSourceExtension('services.test', sourceExtension)),
      content: renderAppServiceTest(appName, sourceExtension),
    },
    {
      target: path.join(appRoot, 'tests', withSourceExtension('routes.test', sourceExtension)),
      content: renderAppRoutesTest(appName, sourceExtension),
    },
  ];
}

export async function ensureAppScaffold(projectRoot, appName, { overwrite = false, sourceExtension = '.js' } = {}) {
  ensureValidName(appName, 'app');

  const appRoot = path.join(projectRoot, 'apps', appName);
  await ensureDir(appRoot);
  await ensureDir(path.join(appRoot, 'tests'));

  const written = [];
  const skipped = [];

  for (const entry of getAppScaffoldEntries(appName, sourceExtension)) {
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

export async function updateProjectRoutesFile(projectRoot, appName, mountPath, sourceExtension = null) {
  const effectiveExtension = sourceExtension || detectProjectSourceExtension(projectRoot);
  const routesFile = resolveSourceFile(path.join(projectRoot, 'routes'), [effectiveExtension]) || resolveSourceFile(path.join(projectRoot, 'routes'));
  if (!routesFile || !(await exists(routesFile))) {
    // Keep backward compatibility for legacy projects that still use routes/index.js.
    return {
      routesFile: routesFile || path.join(projectRoot, withSourceExtension('routes', effectiveExtension)),
      updatedImport: false,
      updatedRoute: false,
      skipped: true,
    };
  }

  const importName = toImportName(appName);
  const importLine = `import ${importName} from './apps/${appName}/routes${effectiveExtension}';`;
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

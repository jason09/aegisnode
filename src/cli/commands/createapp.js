import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { ensureDir, ensureValidName, exists, normalizeMountPath, writeFile } from '../utils/fs.js';
import {
  renderAppRoutes,
  renderAppViewsFile,
  renderAppModelsFile,
  renderAppValidatorsFile,
  renderAppServicesFile,
  renderAppSubscribersFile,
  renderAppModelTest,
  renderAppValidatorTest,
  renderAppServiceTest,
  renderAppRoutesTest,
  renderSettingsApps,
} from '../utils/scaffolds.js';

const APPS_START = '// AEGIS_APPS_START';
const APPS_END = '// AEGIS_APPS_END';

function renderAppEntries(apps) {
  return apps
    .map((app) => `    { name: ${JSON.stringify(app.name)}, mount: ${JSON.stringify(app.mount)} },`)
    .join('\n');
}

function toImportName(appName) {
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

async function detectSettingsMode(projectRoot) {
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

async function hasProjectRoutes(projectRoot) {
  const hasRoutesFile = await exists(path.join(projectRoot, 'routes.js'));
  const hasLegacyRoutes = await exists(path.join(projectRoot, 'routes', 'index.js'));
  return hasRoutesFile || hasLegacyRoutes;
}

async function hasProjectSettings(projectRoot) {
  try {
    await detectSettingsMode(projectRoot);
    return true;
  } catch {
    return false;
  }
}

async function isProjectRoot(projectRoot) {
  const [routesOk, settingsOk] = await Promise.all([
    hasProjectRoutes(projectRoot),
    hasProjectSettings(projectRoot),
  ]);
  return routesOk && settingsOk;
}

async function resolveProjectRoot(projectRootHint) {
  const startDir = path.resolve(projectRootHint);

  let cursor = startDir;
  // 1) Prefer current dir or any parent dir (handles running inside project subfolders).
  while (true) {
    if (await isProjectRoot(cursor)) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  // 2) If not found upward, detect exactly one project in current dir children.
  let entries = [];
  try {
    entries = await fs.readdir(startDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(startDir, entry.name);
    if (await isProjectRoot(candidate)) {
      matches.push(candidate);
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const names = matches.map((item) => path.basename(item)).join(', ');
    throw new Error(`Multiple AegisNode projects found in ${startDir}: ${names}. Use --project <path>.`);
  }

  throw new Error(`Could not find an AegisNode project from ${startDir}. Run inside the project or use --project <path>.`);
}

async function readAppsConfig(settingsMode) {
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

async function updateAppRegistry(projectRoot, apps, settingsMode) {
  if (settingsMode.mode === 'single') {
    await updateSingleSettingsApps(settingsMode.file, apps);
    return;
  }

  await writeFile(path.join(projectRoot, 'settings', 'apps.js'), renderSettingsApps(apps));
}

async function updateProjectRoutesFile(projectRoot, appName, mountPath) {
  const routesFile = path.join(projectRoot, 'routes.js');
  if (!(await exists(routesFile))) {
    // Keep backward compatibility for legacy projects that still use routes/index.js.
    return;
  }

  const importName = toImportName(appName);
  const importLine = `import ${importName} from './apps/${appName}/routes.js';`;
  const routeLine = `    route.use(${JSON.stringify(mountPath)}, ${importName});`;

  let content = await fs.readFile(routesFile, 'utf8');

  if (!content.includes(importLine)) {
    if (content.includes('// AEGIS_APP_IMPORTS_START') && content.includes('// AEGIS_APP_IMPORTS_END')) {
      content = content.replace('// AEGIS_APP_IMPORTS_END', `${importLine}\n// AEGIS_APP_IMPORTS_END`);
    } else {
      content = `${importLine}\n${content}`;
    }
  }

  if (!content.includes(routeLine)) {
    if (content.includes('// AEGIS_PROJECT_APP_ROUTES_START') && content.includes('// AEGIS_PROJECT_APP_ROUTES_END')) {
      content = content.replace('    // AEGIS_PROJECT_APP_ROUTES_END', `${routeLine}\n    // AEGIS_PROJECT_APP_ROUTES_END`);
    } else {
      const match = content.match(/register\s*\([^)]*\)\s*{[\s\S]*?\n\s*}/m);
      if (match) {
        content = content.replace(match[0], `${match[0]}\n${routeLine}`);
      }
    }
  }

  await writeFile(routesFile, content);
}

async function createScaffold(projectRoot, appName) {
  const appRoot = path.join(projectRoot, 'apps', appName);

  await ensureDir(appRoot);
  await ensureDir(path.join(appRoot, 'tests'));

  await writeFile(path.join(appRoot, 'views.js'), renderAppViewsFile(appName));
  await writeFile(path.join(appRoot, 'models.js'), renderAppModelsFile(appName));
  await writeFile(path.join(appRoot, 'validators.js'), renderAppValidatorsFile(appName));
  await writeFile(path.join(appRoot, 'services.js'), renderAppServicesFile(appName));
  await writeFile(path.join(appRoot, 'subscribers.js'), renderAppSubscribersFile(appName));
  await writeFile(path.join(appRoot, 'routes.js'), renderAppRoutes(appName));
  await writeFile(path.join(appRoot, 'tests', 'models.test.js'), renderAppModelTest(appName));
  await writeFile(path.join(appRoot, 'tests', 'validators.test.js'), renderAppValidatorTest(appName));
  await writeFile(path.join(appRoot, 'tests', 'services.test.js'), renderAppServiceTest(appName));
  await writeFile(path.join(appRoot, 'tests', 'routes.test.js'), renderAppRoutesTest(appName));
}

export async function createApp({ appName, projectRoot, mount }) {
  ensureValidName(appName, 'app');

  const resolvedRoot = await resolveProjectRoot(projectRoot);

  const settingsMode = await detectSettingsMode(resolvedRoot);
  const normalizedMount = normalizeMountPath(mount || `/${appName}`);
  const existingApps = await readAppsConfig(settingsMode);

  if (existingApps.some((entry) => entry.name === appName)) {
    throw new Error(`App \"${appName}\" already exists in project settings`);
  }

  const updatedApps = [...existingApps, { name: appName, mount: normalizedMount }];

  await createScaffold(resolvedRoot, appName);
  await updateAppRegistry(resolvedRoot, updatedApps, settingsMode);
  await updateProjectRoutesFile(resolvedRoot, appName, normalizedMount);

  console.log(`App \"${appName}\" created at ${path.join(resolvedRoot, 'apps', appName)}`);
}

import path from 'path';
import { ensureValidName, normalizeMountPath } from '../utils/fs.js';
import { getProjectSourceExtension, resolveProjectRoot } from '../utils/project.js';
import { withSourceExtension } from '../utils/scaffolds.js';
import {
  detectSettingsMode,
  ensureAppScaffold,
  readAppsConfig,
  updateAppRegistry,
  updateProjectRoutesFile,
} from '../utils/apps.js';

export async function runFixApp({ appName, projectRoot, mount } = {}) {
  if (!appName) {
    throw new Error('Missing app name. Usage: aegisnode fix --app <app-name>');
  }

  ensureValidName(appName, 'app');

  const resolvedRoot = await resolveProjectRoot(projectRoot || process.cwd());
  const sourceExtension = getProjectSourceExtension(resolvedRoot);
  const settingsMode = await detectSettingsMode(resolvedRoot);
  const existingApps = await readAppsConfig(settingsMode);
  const existingApp = existingApps.find((entry) => entry.name === appName) || null;
  const appMount = existingApp?.mount || normalizeMountPath(mount || `/${appName}`);

  const scaffoldResult = await ensureAppScaffold(resolvedRoot, appName, {
    overwrite: false,
    sourceExtension,
  });

  let registryUpdated = false;
  if (!existingApp) {
    await updateAppRegistry(
      resolvedRoot,
      [...existingApps, { name: appName, mount: appMount }],
      settingsMode,
    );
    registryUpdated = true;
  }

  const routesResult = await updateProjectRoutesFile(resolvedRoot, appName, appMount, sourceExtension);
  const relativeWritten = scaffoldResult.written.map((target) => path.relative(resolvedRoot, target));

  if (relativeWritten.length === 0 && !registryUpdated && !routesResult.updatedImport && !routesResult.updatedRoute) {
    console.log(`App "${appName}" is already complete.`);
  } else {
    console.log(`App "${appName}" repaired at ${resolvedRoot}/apps/${appName}`);
    if (relativeWritten.length > 0) {
      console.log(`Created missing files: ${relativeWritten.join(', ')}`);
    }
    if (registryUpdated) {
      console.log(`Added app "${appName}" to settings.apps with mount ${appMount}`);
    }
    if (routesResult.updatedImport || routesResult.updatedRoute) {
      console.log(`Updated ${path.basename(routesResult.routesFile || withSourceExtension('routes', sourceExtension))} registration for app "${appName}"`);
    }
  }

  return {
    rootDir: resolvedRoot,
    appName,
    mount: appMount,
    createdFiles: scaffoldResult.written,
    skippedFiles: scaffoldResult.skipped,
    registryUpdated,
    routesUpdated: routesResult.updatedImport || routesResult.updatedRoute,
    routesFile: routesResult.routesFile,
  };
}

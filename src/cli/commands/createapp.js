import { ensureValidName, normalizeMountPath } from '../utils/fs.js';
import { resolveProjectRoot } from '../utils/project.js';
import {
  detectSettingsMode,
  ensureAppScaffold,
  readAppsConfig,
  updateAppRegistry,
  updateProjectRoutesFile,
} from '../utils/apps.js';

export async function createApp({ appName, projectRoot, mount }) {
  ensureValidName(appName, 'app');

  const resolvedRoot = await resolveProjectRoot(projectRoot);
  const settingsMode = await detectSettingsMode(resolvedRoot);
  const normalizedMount = normalizeMountPath(mount || `/${appName}`);
  const existingApps = await readAppsConfig(settingsMode);

  if (existingApps.some((entry) => entry.name === appName)) {
    throw new Error(`App "${appName}" already exists in project settings`);
  }

  await ensureAppScaffold(resolvedRoot, appName);
  await updateAppRegistry(resolvedRoot, [...existingApps, { name: appName, mount: normalizedMount }], settingsMode);
  await updateProjectRoutesFile(resolvedRoot, appName, normalizedMount);

  console.log(`App "${appName}" created at ${resolvedRoot}/apps/${appName}`);
}

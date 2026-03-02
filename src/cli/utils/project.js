import fs from 'fs/promises';
import path from 'path';
import { exists } from './fs.js';

export async function hasRoutesFile(projectRoot) {
  return (await exists(path.join(projectRoot, 'routes.js')))
    || (await exists(path.join(projectRoot, 'routes', 'index.js')));
}

export async function hasSettingsFile(projectRoot) {
  return (await exists(path.join(projectRoot, 'settings.js')))
    || (await exists(path.join(projectRoot, 'settings', 'index.js')))
    || (await exists(path.join(projectRoot, 'settings', 'apps.js')));
}

export async function isProjectRoot(projectRoot) {
  const [hasRoutes, hasSettings] = await Promise.all([
    hasRoutesFile(projectRoot),
    hasSettingsFile(projectRoot),
  ]);
  return hasRoutes && hasSettings;
}

export async function resolveProjectRoot(projectRootHint) {
  const startDir = path.resolve(projectRootHint);

  let cursor = startDir;
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

  throw new Error(`Could not find an AegisNode project from ${startDir}. Run inside project or use --project <path>.`);
}

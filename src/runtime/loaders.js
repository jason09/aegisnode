import path from 'path';
import { pathToFileURL } from 'url';

async function resolveLoader(loaderEntry, rootDir) {
  if (typeof loaderEntry === 'function') {
    return { loader: loaderEntry, options: {} };
  }

  if (typeof loaderEntry === 'string') {
    const filePath = path.isAbsolute(loaderEntry)
      ? loaderEntry
      : path.join(rootDir, loaderEntry);
    const loaded = await import(pathToFileURL(filePath).href);
    return { loader: loaded.default ?? loaded, options: {} };
  }

  if (loaderEntry && typeof loaderEntry === 'object' && typeof loaderEntry.path === 'string') {
    const filePath = path.isAbsolute(loaderEntry.path)
      ? loaderEntry.path
      : path.join(rootDir, loaderEntry.path);
    const loaded = await import(pathToFileURL(filePath).href);
    return {
      loader: loaded.default ?? loaded,
      options: loaderEntry.options || {},
    };
  }

  throw new Error(`Invalid loader entry: ${JSON.stringify(loaderEntry)}`);
}

export async function runLoaders(loaderEntries, context, rootDir, logger) {
  if (!Array.isArray(loaderEntries) || loaderEntries.length === 0) {
    return;
  }

  for (const entry of loaderEntries) {
    const { loader, options } = await resolveLoader(entry, rootDir);

    if (typeof loader !== 'function') {
      throw new Error('Loader module must export a function.');
    }

    logger.info('Running loader: %s', typeof entry === 'string' ? entry : 'inline-loader');
    await loader({ ...context, options });
  }
}

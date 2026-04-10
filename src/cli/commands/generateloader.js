import path from 'path';
import { exists, writeFile } from '../utils/fs.js';
import { getProjectSourceExtension, resolveProjectRoot } from '../utils/project.js';
import { renderProjectAppJs, renderProjectLoaderCjs, withSourceExtension } from '../utils/scaffolds.js';

async function ensureStartupFile(rootDir, fileName, content, output) {
  const target = path.join(rootDir, fileName);
  if (await exists(target)) {
    output.log(`${fileName} already exists.`);
    return false;
  }

  await writeFile(target, content);
  output.log(`Generated ${fileName}.`);
  return true;
}

export async function runGenerateLoader({
  projectRoot,
  output = console,
} = {}) {
  const resolvedRoot = await resolveProjectRoot(projectRoot || process.cwd());
  const sourceExtension = getProjectSourceExtension(resolvedRoot);
  const createdApp = await ensureStartupFile(
    resolvedRoot,
    withSourceExtension('app', sourceExtension),
    renderProjectAppJs(),
    output,
  );
  const createdLoader = await ensureStartupFile(resolvedRoot, 'loader.cjs', renderProjectLoaderCjs(sourceExtension), output);

  if (!createdApp && !createdLoader) {
    output.log(`Startup entry files already exist in ${resolvedRoot}`);
  } else {
    output.log(`Startup entry files are ready in ${resolvedRoot}`);
  }

  return {
    rootDir: resolvedRoot,
    createdApp,
    createdLoader,
  };
}

import crypto from 'crypto';
import path from 'path';
import { ensureDir, ensureValidName, exists, isDirectoryEmpty, writeFile } from '../utils/fs.js';
import {
  renderEnvExample,
  renderProjectEnv,
  renderProjectAppJs,
  renderProjectGitIgnore,
  renderProjectLoaderCjs,
  renderProjectPackageJson,
  renderProjectRoutes,
  renderProjectSettings,
  renderTsConfig,
  withSourceExtension,
} from '../utils/scaffolds.js';

async function createSecret() {
  try {
    const jliveModule = await import('jlive');
    const JliveEncrypt = jliveModule?.JliveEncrypt;
    if (JliveEncrypt && typeof JliveEncrypt.generate === 'function') {
      return JliveEncrypt.generate(64);
    }
  } catch {
    // Fallback when jlive is not installed or not compatible.
  }

  return crypto.randomBytes(32).toString('hex');
}

async function assertCanCreateProject(projectDir) {
  if (!(await exists(projectDir))) {
    return;
  }

  const empty = await isDirectoryEmpty(projectDir);
  if (!empty) {
    throw new Error(`Directory already exists and is not empty: ${projectDir}`);
  }
}

async function createBaseProjectFiles(projectRoot, projectName, { typescript = false } = {}) {
  const apps = [];
  const appSecret = await createSecret();
  const sourceExtension = typescript ? '.ts' : '.js';

  await ensureDir(projectRoot);
  await Promise.all([
    ensureDir(path.join(projectRoot, 'apps')),
  ]);

  await writeFile(path.join(projectRoot, withSourceExtension('app', sourceExtension)), renderProjectAppJs());
  await writeFile(path.join(projectRoot, 'loader.cjs'), renderProjectLoaderCjs(sourceExtension));
  await writeFile(path.join(projectRoot, 'package.json'), renderProjectPackageJson(projectName, { typescript }));
  await writeFile(path.join(projectRoot, '.gitignore'), renderProjectGitIgnore());
  await writeFile(path.join(projectRoot, '.env'), renderProjectEnv(appSecret));
  await writeFile(path.join(projectRoot, '.env.example'), renderEnvExample());

  await writeFile(path.join(projectRoot, withSourceExtension('settings', sourceExtension)), renderProjectSettings(projectName, apps, appSecret));
  await writeFile(path.join(projectRoot, withSourceExtension('routes', sourceExtension)), renderProjectRoutes());
  if (typescript) {
    await writeFile(path.join(projectRoot, 'tsconfig.json'), renderTsConfig());
  }
}

export async function startProject({ projectName, cwd, typescript = false }) {
  ensureValidName(projectName, 'project');

  const projectRoot = path.resolve(cwd, projectName);
  await assertCanCreateProject(projectRoot);
  await createBaseProjectFiles(projectRoot, projectName, { typescript });

  console.log(`AegisNode project created at ${projectRoot}`);
  console.log('Next steps:');
  console.log(`  cd ${projectName}`);
  console.log('  npm install');
  console.log('  aegisnode runserver');
}

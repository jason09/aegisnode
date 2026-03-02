import crypto from 'crypto';
import path from 'path';
import { ensureDir, ensureValidName, exists, isDirectoryEmpty, writeFile } from '../utils/fs.js';
import {
  renderEnvExample,
  renderProjectAppJs,
  renderProjectGitIgnore,
  renderProjectPackageJson,
  renderProjectRoutes,
  renderProjectSettings,
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

async function createBaseProjectFiles(projectRoot, projectName) {
  const apps = [];
  const appSecret = await createSecret();

  await ensureDir(projectRoot);
  await Promise.all([
    ensureDir(path.join(projectRoot, 'apps')),
  ]);

  await writeFile(path.join(projectRoot, 'app.js'), renderProjectAppJs());
  await writeFile(path.join(projectRoot, 'package.json'), renderProjectPackageJson(projectName));
  await writeFile(path.join(projectRoot, '.gitignore'), renderProjectGitIgnore());
  await writeFile(path.join(projectRoot, '.env.example'), renderEnvExample());

  await writeFile(path.join(projectRoot, 'settings.js'), renderProjectSettings(projectName, appSecret, apps));
  await writeFile(path.join(projectRoot, 'routes.js'), renderProjectRoutes());
}

export async function startProject({ projectName, cwd }) {
  ensureValidName(projectName, 'project');

  const projectRoot = path.resolve(cwd, projectName);
  await assertCanCreateProject(projectRoot);
  await createBaseProjectFiles(projectRoot, projectName);

  console.log(`AegisNode project created at ${projectRoot}`);
  console.log('Next steps:');
  console.log(`  cd ${projectName}`);
  console.log('  npm install');
  console.log('  aegisnode runserver');
}

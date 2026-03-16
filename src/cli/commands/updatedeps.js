import fs from 'fs/promises';
import http from 'http';
import https from 'https';
import path from 'path';
import { spawn } from 'child_process';
import { resolveProjectRoot } from '../utils/project.js';
import { exists, writeFile } from '../utils/fs.js';

const DEFAULT_REGISTRY_BASE_URL = 'https://registry.npmjs.org/';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const UNSUPPORTED_SPEC_PREFIXES = [
  'file:',
  'link:',
  'workspace:',
  'git:',
  'git+',
  'github:',
  'http:',
  'https:',
];
const MAX_REDIRECTS = 5;

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function encodePackageName(name) {
  return name.replace(/\//g, '%2f');
}

function getVersionPrefix(spec) {
  if (typeof spec !== 'string' || spec.length === 0) {
    return '';
  }

  if (spec.startsWith('^') || spec.startsWith('~')) {
    return spec[0];
  }

  return '';
}

function isRegistryDependencySpec(spec) {
  if (typeof spec !== 'string' || spec.trim().length === 0) {
    return false;
  }

  const normalized = spec.trim();
  if (normalized.startsWith('npm:')) {
    return parseNpmAliasSpec(normalized) !== null;
  }

  return !UNSUPPORTED_SPEC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parseNpmAliasSpec(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) {
    return null;
  }

  const remainder = spec.slice(4);
  const versionDelimiter = remainder.lastIndexOf('@');
  if (versionDelimiter <= 0) {
    return null;
  }

  const targetPackageName = remainder.slice(0, versionDelimiter);
  const targetVersionSpec = remainder.slice(versionDelimiter + 1);
  if (targetPackageName.trim().length === 0 || targetVersionSpec.trim().length === 0) {
    return null;
  }

  return {
    targetPackageName,
    targetVersionSpec,
  };
}

function resolveRegistryPackageName(packageName, versionSpec) {
  const aliasSpec = parseNpmAliasSpec(versionSpec);
  if (aliasSpec) {
    return aliasSpec.targetPackageName;
  }

  return packageName;
}

function buildNextVersionSpec(versionSpec, latestVersion) {
  const aliasSpec = parseNpmAliasSpec(versionSpec);
  if (aliasSpec) {
    return `npm:${aliasSpec.targetPackageName}@${getVersionPrefix(aliasSpec.targetVersionSpec)}${latestVersion}`;
  }

  return `${getVersionPrefix(String(versionSpec))}${latestVersion}`;
}

function parsePackageManager(packageJson) {
  const declared = packageJson?.packageManager;
  if (typeof declared === 'string' && declared.includes('@')) {
    const [manager] = declared.split('@');
    if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
      return manager;
    }
  }

  return null;
}

async function detectPackageManager(projectRoot, packageJson) {
  const declared = parsePackageManager(packageJson);
  if (declared) {
    return declared;
  }

  if (await exists(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (await exists(path.join(projectRoot, 'yarn.lock'))) {
    return 'yarn';
  }

  if (await exists(path.join(projectRoot, 'bun.lockb')) || await exists(path.join(projectRoot, 'bun.lock'))) {
    return 'bun';
  }

  return 'npm';
}

async function requestJson(url, redirectCount = 0) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.get(target, {
      headers: {
        accept: 'application/json',
      },
    }, (response) => {
      const status = response.statusCode || 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`Registry request exceeded redirect limit for ${url}.`));
          return;
        }

        response.resume();
        const nextUrl = new URL(response.headers.location, target).toString();
        requestJson(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          const detail = body.trim().slice(0, 200);
          reject(new Error(`Registry request failed for ${url}: ${status}${detail ? ` ${detail}` : ''}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Registry returned invalid JSON for ${url}: ${error.message}`));
        }
      });
    });

    request.on('error', reject);
  });
}

function createLatestVersionResolver({
  registryBaseUrl = DEFAULT_REGISTRY_BASE_URL,
  fetchJson = requestJson,
} = {}) {
  const cache = new Map();
  const baseUrl = ensureTrailingSlash(registryBaseUrl);

  return async function resolveLatestVersion(packageName) {
    if (!cache.has(packageName)) {
      cache.set(packageName, (async () => {
        const url = new URL(encodePackageName(packageName), baseUrl).toString();
        const metadata = await fetchJson(url);
        const latestVersion = metadata?.['dist-tags']?.latest;

        if (typeof latestVersion !== 'string' || latestVersion.trim().length === 0) {
          throw new Error(`Package "${packageName}" is missing dist-tags.latest in ${url}.`);
        }

        return latestVersion.trim();
      })());
    }

    return cache.get(packageName);
  };
}

function getInstallCommand(packageManager) {
  const binary = process.platform === 'win32' ? `${packageManager}.cmd` : packageManager;
  return {
    command: binary,
    args: ['install'],
  };
}

async function runInstall(projectRoot, packageManager, output) {
  const { command, args } = getInstallCommand(packageManager);
  output.log(`Running ${packageManager} install...`);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`${packageManager} install terminated by signal ${signal}.`));
        return;
      }

      reject(new Error(`${packageManager} install failed with exit code ${code}.`));
    });
  });
}

export async function runUpdateDependencies({
  projectRoot,
  registryBaseUrl = DEFAULT_REGISTRY_BASE_URL,
  installDependencies = true,
  output = console,
} = {}) {
  const resolvedRoot = await resolveProjectRoot(projectRoot || process.cwd());
  const packageJsonPath = path.join(resolvedRoot, 'package.json');
  let packageJsonRaw;

  try {
    packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read package.json from ${packageJsonPath}: ${error.message}`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonRaw);
  } catch (error) {
    throw new Error(`Invalid package.json at ${packageJsonPath}: ${error.message}`);
  }

  const resolveLatestVersion = createLatestVersionResolver({ registryBaseUrl });
  const updatedEntries = [];
  const unchangedEntries = [];
  const skippedEntries = [];
  let totalDependencyEntries = 0;

  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = packageJson?.[section];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      continue;
    }

    const entries = Object.entries(dependencies);

    await Promise.all(entries.map(async ([packageName, versionSpec]) => {
      totalDependencyEntries += 1;

      if (!isRegistryDependencySpec(versionSpec)) {
        skippedEntries.push({
          section,
          packageName,
          versionSpec,
          reason: `unsupported source spec "${String(versionSpec)}"`,
        });
        return;
      }

      const latestVersion = await resolveLatestVersion(resolveRegistryPackageName(packageName, versionSpec));
      const nextVersionSpec = buildNextVersionSpec(versionSpec, latestVersion);

      if (String(versionSpec) === nextVersionSpec) {
        unchangedEntries.push({
          section,
          packageName,
          versionSpec: String(versionSpec),
        });
        return;
      }

      dependencies[packageName] = nextVersionSpec;
      updatedEntries.push({
        section,
        packageName,
        from: String(versionSpec),
        to: nextVersionSpec,
      });
    }));
  }

  if (totalDependencyEntries === 0) {
    output.log(`No dependencies found in ${packageJsonPath}.`);
    return {
      rootDir: resolvedRoot,
      packageManager: null,
      updatedEntries,
      unchangedEntries,
      skippedEntries,
    };
  }

  if (updatedEntries.length > 0) {
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    for (const entry of updatedEntries) {
      output.log(`Updated ${entry.section}.${entry.packageName}: ${entry.from} -> ${entry.to}`);
    }
  } else {
    output.log('All registry-backed dependency specs are already on the current latest version.');
  }

  for (const entry of skippedEntries) {
    output.log(`Skipped ${entry.section}.${entry.packageName}: ${entry.reason}`);
  }

  const packageManager = updatedEntries.length > 0 && installDependencies
    ? await detectPackageManager(resolvedRoot, packageJson)
    : null;

  if (packageManager) {
    await runInstall(resolvedRoot, packageManager, output);
  }

  output.log(
    `updatedeps summary: ${updatedEntries.length} updated, ${unchangedEntries.length} unchanged, ${skippedEntries.length} skipped.`,
  );

  return {
    rootDir: resolvedRoot,
    packageManager,
    updatedEntries,
    unchangedEntries,
    skippedEntries,
  };
}

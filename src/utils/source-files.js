import fs from 'fs';
import path from 'path';

export const SOURCE_EXTENSIONS = Object.freeze(['.js', '.ts']);
export const DEFAULT_SOURCE_EXTENSION = '.js';
export const TYPESCRIPT_SOURCE_EXTENSION = '.ts';

const SOURCE_FILE_PATTERN = /\.(?:js|ts)$/i;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSourceFileName(fileName) {
  return SOURCE_FILE_PATTERN.test(String(fileName || ''));
}

export function isTypeScriptFile(filePath) {
  return String(filePath || '').toLowerCase().endsWith(TYPESCRIPT_SOURCE_EXTENSION);
}

export function stripSourceExtension(fileName) {
  return String(fileName || '').replace(/\.(?:js|ts)$/i, '');
}

export function hasNamedSourceSuffix(fileName, suffix) {
  return new RegExp(`${escapeRegExp(suffix)}\\.(?:js|ts)$`, 'i').test(String(fileName || ''));
}

export function resolveSourceFile(basePath, extensions = SOURCE_EXTENSIONS) {
  for (const extension of extensions) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveSourceIndexFile(directoryPath, extensions = SOURCE_EXTENSIONS) {
  for (const extension of extensions) {
    const candidate = path.join(directoryPath, `index${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function detectProjectSourceExtension(rootDir) {
  const tsSignals = [
    resolveSourceFile(path.join(rootDir, 'settings'), [TYPESCRIPT_SOURCE_EXTENSION]),
    resolveSourceFile(path.join(rootDir, 'app'), [TYPESCRIPT_SOURCE_EXTENSION]),
    resolveSourceFile(path.join(rootDir, 'routes'), [TYPESCRIPT_SOURCE_EXTENSION]),
    resolveSourceIndexFile(path.join(rootDir, 'settings'), [TYPESCRIPT_SOURCE_EXTENSION]),
  ];
  if (tsSignals.some(Boolean)) {
    return TYPESCRIPT_SOURCE_EXTENSION;
  }

  const jsSignals = [
    resolveSourceFile(path.join(rootDir, 'settings'), [DEFAULT_SOURCE_EXTENSION]),
    resolveSourceFile(path.join(rootDir, 'app'), [DEFAULT_SOURCE_EXTENSION]),
    resolveSourceFile(path.join(rootDir, 'routes'), [DEFAULT_SOURCE_EXTENSION]),
    resolveSourceIndexFile(path.join(rootDir, 'settings'), [DEFAULT_SOURCE_EXTENSION]),
  ];
  if (jsSignals.some(Boolean)) {
    return DEFAULT_SOURCE_EXTENSION;
  }

  if (fs.existsSync(path.join(rootDir, 'tsconfig.json'))) {
    return TYPESCRIPT_SOURCE_EXTENSION;
  }

  return DEFAULT_SOURCE_EXTENSION;
}

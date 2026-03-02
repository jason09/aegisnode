import fs from 'fs/promises';
import path from 'path';

export async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectoryEmpty(targetPath) {
  const entries = await fs.readdir(targetPath);
  return entries.length === 0;
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function writeFile(targetPath, content) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, 'utf8');
}

export function normalizeMountPath(input) {
  if (!input || input === '/') {
    return '/';
  }

  const normalized = `/${String(input).trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length === 0) {
    return '/';
  }

  const invalidSegment = segments.find((segment) => !/^[a-zA-Z0-9:_-]+$/.test(segment));
  if (invalidSegment) {
    throw new Error(
      `Invalid mount path segment "${invalidSegment}". Use letters, numbers, "_", "-", and optional ":" params only.`,
    );
  }

  return `/${segments.join('/')}`;
}

export function ensureValidName(input, type) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
    throw new Error(`Invalid ${type} name \"${input}\". Use letters, numbers, _ and - only.`);
  }
}

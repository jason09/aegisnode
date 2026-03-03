import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';

function asNonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

function parseBytes(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    return fallback;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallback;
  }

  const unit = String(match[2] || 'b').toLowerCase();
  const multiplier = unit === 'gb'
    ? 1024 * 1024 * 1024
    : unit === 'mb'
      ? 1024 * 1024
      : unit === 'kb'
        ? 1024
        : 1;

  return Math.max(1, Math.floor(amount * multiplier));
}

function normalizeStringList(value, { lowerCase = false } = {}) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);

  const normalized = source
    .map((entry) => asNonEmptyString(entry))
    .filter(Boolean)
    .map((entry) => (lowerCase ? entry.toLowerCase() : entry));

  return [...new Set(normalized)];
}

function normalizeExtensions(value) {
  return normalizeStringList(value, { lowerCase: true })
    .map((entry) => (entry.startsWith('.') ? entry : `.${entry}`));
}

function normalizeUploadDirectory(rawDir, rootDir) {
  const dir = asNonEmptyString(rawDir, 'uploads');
  return path.isAbsolute(dir) ? dir : path.join(rootDir, dir);
}

export function normalizeUploadsConfig(rawUploads, rootDir) {
  const uploads = rawUploads && typeof rawUploads === 'object' ? rawUploads : {};
  const directory = normalizeUploadDirectory(uploads.dir, rootDir);

  return {
    enabled: uploads.enabled !== false,
    dir: asNonEmptyString(uploads.dir, 'uploads'),
    directory,
    createDir: uploads.createDir !== false,
    preserveExtension: uploads.preserveExtension !== false,
    maxFileSize: parseBytes(uploads.maxFileSize, 5 * 1024 * 1024),
    maxFiles: asPositiveInteger(uploads.maxFiles, 5),
    maxFields: asPositiveInteger(uploads.maxFields, 50),
    maxFieldSize: parseBytes(uploads.maxFieldSize, 1024 * 1024),
    allowedMimeTypes: normalizeStringList(uploads.allowedMimeTypes, { lowerCase: true }),
    allowedExtensions: normalizeExtensions(uploads.allowedExtensions),
    allowApiMultipart: uploads.allowApiMultipart !== false,
  };
}

function randomName(bytes = 16) {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return crypto.randomBytes(bytes).toString('hex');
}

function getExtension(fileName, preserveExtension) {
  if (!preserveExtension) {
    return '';
  }
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ext && ext.length <= 10 ? ext : '';
}

function createUploadError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function resolveUploadError(error) {
  if (!error) {
    return null;
  }

  if (typeof error.statusCode === 'number' && error.statusCode >= 400) {
    return error;
  }

  const multerCode = String(error.code || '');
  switch (multerCode) {
    case 'LIMIT_FILE_SIZE':
      return createUploadError(multerCode, 'Uploaded file exceeds the configured size limit.', 413);
    case 'LIMIT_FILE_COUNT':
      return createUploadError(multerCode, 'Too many files uploaded.', 413);
    case 'LIMIT_FIELD_COUNT':
      return createUploadError(multerCode, 'Too many form fields submitted.', 413);
    case 'LIMIT_FIELD_VALUE':
      return createUploadError(multerCode, 'A form field exceeds the configured size limit.', 413);
    case 'LIMIT_UNEXPECTED_FILE':
      return createUploadError(multerCode, 'Unexpected file field.', 400);
    default:
      return createUploadError('UPLOAD_ERROR', error.message || 'Upload failed.', 400);
  }
}

function createDiskStorage(uploadConfig) {
  return multer.diskStorage({
    destination(_req, _file, callback) {
      callback(null, uploadConfig.directory);
    },
    filename(_req, file, callback) {
      callback(null, `${randomName()}${getExtension(file?.originalname, uploadConfig.preserveExtension)}`);
    },
  });
}

function createFileFilter(uploadConfig) {
  return (_req, file, callback) => {
    const mimeType = String(file?.mimetype || '').toLowerCase();
    const extension = path.extname(String(file?.originalname || '')).toLowerCase();

    if (
      uploadConfig.allowedMimeTypes.length > 0
      && !uploadConfig.allowedMimeTypes.includes(mimeType)
    ) {
      callback(createUploadError(
        'AEGIS_UPLOAD_MIME_NOT_ALLOWED',
        `File type "${mimeType || 'unknown'}" is not allowed.`,
        415,
      ));
      return;
    }

    if (
      uploadConfig.allowedExtensions.length > 0
      && !uploadConfig.allowedExtensions.includes(extension)
    ) {
      callback(createUploadError(
        'AEGIS_UPLOAD_EXTENSION_NOT_ALLOWED',
        `File extension "${extension || '(none)'}" is not allowed.`,
        415,
      ));
      return;
    }

    callback(null, true);
  };
}

function createMulterOptions(uploadConfig) {
  return {
    storage: createDiskStorage(uploadConfig),
    limits: {
      fileSize: uploadConfig.maxFileSize,
      files: uploadConfig.maxFiles,
      fields: uploadConfig.maxFields,
      fieldSize: uploadConfig.maxFieldSize,
    },
    fileFilter: createFileFilter(uploadConfig),
  };
}

function wrapUploadMiddleware(middleware) {
  return (req, res, next) => {
    middleware(req, res, (error) => {
      if (!error) {
        next();
        return;
      }

      const resolved = resolveUploadError(error);
      if (res.headersSent) {
        next(resolved);
        return;
      }

      res.status(resolved.statusCode || 400).json({
        error: resolved.message || 'Upload failed.',
      });
    });
  };
}

export async function createUploadManager(uploadConfig, logger) {
  if (!uploadConfig?.enabled) {
    return null;
  }

  if (uploadConfig.createDir) {
    await fs.mkdir(uploadConfig.directory, { recursive: true });
  }

  const uploader = multer(createMulterOptions(uploadConfig));
  logger.debug(
    'Uploads enabled: dir=%s maxFileSize=%s maxFiles=%s',
    uploadConfig.directory,
    uploadConfig.maxFileSize,
    uploadConfig.maxFiles,
  );

  return {
    config: {
      ...uploadConfig,
      directory: uploadConfig.directory,
    },
    single(fieldName) {
      return wrapUploadMiddleware(uploader.single(String(fieldName || 'file')));
    },
    array(fieldName, maxCount = undefined) {
      const count = typeof maxCount === 'number' && Number.isFinite(maxCount) && maxCount > 0
        ? Math.floor(maxCount)
        : undefined;
      return wrapUploadMiddleware(uploader.array(String(fieldName || 'files'), count));
    },
    fields(definitions) {
      return wrapUploadMiddleware(uploader.fields(Array.isArray(definitions) ? definitions : []));
    },
    any() {
      return wrapUploadMiddleware(uploader.any());
    },
    none() {
      return wrapUploadMiddleware(uploader.none());
    },
  };
}

export function isMultipartRequestContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('multipart/form-data');
}

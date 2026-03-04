import crypto from 'crypto';
import mongoose from 'mongoose';

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function asNonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const fromString = new Date(value);
    return Number.isNaN(fromString.getTime()) ? null : fromString;
  }

  return null;
}

function toUnixSeconds(value, fallback = Math.floor(Date.now() / 1000)) {
  if (value instanceof Date) {
    const asSeconds = Math.floor(value.getTime() / 1000);
    return Number.isFinite(asSeconds) ? asSeconds : fallback;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Math.abs(value) >= 1e12) {
      return Math.floor(value / 1000);
    }
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const fromNumber = Number(value);
    if (Number.isFinite(fromNumber)) {
      return toUnixSeconds(fromNumber, fallback);
    }

    const fromDate = new Date(value);
    if (!Number.isNaN(fromDate.getTime())) {
      return Math.floor(fromDate.getTime() / 1000);
    }
  }

  return fallback;
}

function pad2(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return '00';
  }
  return String(parsed).padStart(2, '0');
}

function formatDateDmy(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}-${date.getFullYear()}`;
}

function getMongooseObjectIdCtor() {
  return mongoose?.Types?.ObjectId || null;
}

function normalizeObjectIdString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

export function isObjectId(value) {
  const ObjectIdCtor = getMongooseObjectIdCtor();
  if (!ObjectIdCtor) {
    return false;
  }

  if (value instanceof ObjectIdCtor) {
    return true;
  }

  const candidate = normalizeObjectIdString(value);
  if (candidate.length === 0) {
    return false;
  }

  if (typeof mongoose?.isValidObjectId === 'function') {
    return mongoose.isValidObjectId(candidate);
  }

  return /^[a-fA-F0-9]{24}$/.test(candidate);
}

export function toObjectId(value) {
  const ObjectIdCtor = getMongooseObjectIdCtor();
  if (!ObjectIdCtor) {
    return null;
  }

  if (value instanceof ObjectIdCtor) {
    return value;
  }

  const candidate = normalizeObjectIdString(value);
  if (!isObjectId(candidate)) {
    return null;
  }

  try {
    return new ObjectIdCtor(candidate);
  } catch {
    return null;
  }
}

export function money(value, options = {}) {
  const amount = asFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(amount)) {
    return '';
  }

  const locale = asNonEmptyString(options.locale, 'en-US');
  const currency = asNonEmptyString(options.currency, 'USD');

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: options.currencyDisplay || 'symbol',
    minimumFractionDigits: Number.isInteger(options.minimumFractionDigits) ? options.minimumFractionDigits : undefined,
    maximumFractionDigits: Number.isInteger(options.maximumFractionDigits) ? options.maximumFractionDigits : undefined,
  });

  return formatter.format(amount);
}

export function number(value, options = {}) {
  const parsed = asFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) {
    return '';
  }

  const locale = asNonEmptyString(options.locale, 'en-US');
  const formatter = new Intl.NumberFormat(locale, options);
  return formatter.format(parsed);
}

export function dateTime(value, options = {}) {
  const date = toDate(value);
  if (!date) {
    return '';
  }

  const locale = asNonEmptyString(options.locale, 'en-US');
  const formatOptions = { ...options };
  delete formatOptions.locale;

  if (Object.keys(formatOptions).length === 0) {
    formatOptions.dateStyle = 'medium';
    formatOptions.timeStyle = 'short';
  }

  return new Intl.DateTimeFormat(locale, formatOptions).format(date);
}

const ELAPSED_UNITS = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

function timeElapsedIntl(value, options = {}) {
  const date = toDate(value);
  if (!date) {
    return '';
  }

  const locale = asNonEmptyString(options.locale, 'en-US');
  const nowValue = options.now instanceof Date
    ? options.now.getTime()
    : (typeof options.now === 'number' ? options.now : Date.now());
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const diffSeconds = Math.round((now - date.getTime()) / 1000);

  if (Math.abs(diffSeconds) < 5) {
    return 'just now';
  }

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: options.numeric || 'auto' });
  const absSeconds = Math.abs(diffSeconds);

  for (const [unit, unitSeconds] of ELAPSED_UNITS) {
    if (absSeconds >= unitSeconds || unit === 'second') {
      const count = Math.floor(absSeconds / unitSeconds);
      return rtf.format(diffSeconds > 0 ? -count : count, unit);
    }
  }

  return 'just now';
}

function trimSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatElapsedStyle(time, short = false) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const targetSeconds = toUnixSeconds(time, nowSeconds);
  const endText = targetSeconds > nowSeconds ? '' : 'ago';

  let diff = Math.abs(nowSeconds - targetSeconds);

  const difYear = Math.floor(diff / 31536000);
  diff -= difYear * 31536000;

  const difMonth = Math.floor(diff / 2592000);
  diff -= difMonth * 2592000;

  const difWeek = Math.floor(diff / 604800);
  diff -= difWeek * 604800;

  const difDay = Math.floor(diff / 86400);
  diff -= difDay * 86400;

  const difHour = Math.floor(diff / 3600);
  diff -= difHour * 3600;

  const difMin = Math.floor(diff / 60);
  diff -= difMin * 60;

  const difSec = Math.floor(diff);

  if (short) {
    if (difMonth > 0 && difMonth < 13) {
      return trimSpaces(`${difMonth} Month ${endText}`);
    }

    if (difWeek > 0 && difWeek < 5) {
      return trimSpaces(`${difWeek} Week ${endText}`);
    }

    if (difDay === 0) {
      if (difHour > 5 && difHour < 24) {
        return trimSpaces(`Today ${difHour} heure`);
      }

      if (difHour > 0) {
        return trimSpaces(`Just ${difHour} heures`);
      }

      if (difMin > 0) {
        return trimSpaces(`Just ${difMin} mn`);
      }

      return difSec === 0 ? 'Just Now' : trimSpaces(`Just ${difSec} secondes`);
    }

    if (difDay === 1) {
      return 'Yesterday';
    }

    if (difDay > 1 && difDay < 7) {
      return trimSpaces(`${difDay} days ${endText}`);
    }

    return formatDateDmy(targetSeconds);
  }

  if (difMonth > 0 && difMonth < 13) {
    if (difDay === 0) {
      return trimSpaces(`${difMonth} Month ${endText}`);
    }
    return trimSpaces(`${difMonth} Month ${difDay} Days ${endText}`);
  }

  if (difWeek > 0 && difWeek < 5) {
    if (difDay === 0) {
      return trimSpaces(`${difWeek} Week ${endText}`);
    }
    return trimSpaces(`${difWeek} Week ${difDay} Days ${endText}`);
  }

  if (difDay === 0) {
    if (difHour > 5 && difHour < 24) {
      return trimSpaces(`Today ${difHour} heure ${difMin} mn`);
    }

    if (difHour > 0) {
      return trimSpaces(`Just ${difHour} heures ${difMin} mn`);
    }

    if (difMin > 0) {
      return trimSpaces(`Just ${difMin} mn`);
    }

    return difSec === 0 ? 'Just Now' : trimSpaces(`Just ${difSec} secondes`);
  }

  if (difDay === 1) {
    return 'Yesterday';
  }

  if (difDay > 1 && difDay < 7) {
    return trimSpaces(`${difDay} days ${endText}`);
  }

  return formatDateDmy(targetSeconds);
}

export function timeElapsed(time, shortOrOptions = false) {
  if (isPlainObject(shortOrOptions)) {
    return timeElapsedIntl(time, shortOrOptions);
  }

  return formatElapsedStyle(time, Boolean(shortOrOptions));
}

export function timeDifference(today, start, end, rounded = true) {
  const q = Math.abs(asFiniteNumber(today, 0) - asFiniteNumber(start, 0));
  const d = Math.abs(asFiniteNumber(end, 0) - asFiniteNumber(start, 0));
  const raw = (q / d) * 100;
  const value = rounded ? Math.round(raw) : raw;
  return Number.isFinite(value) ? value : 0;
}

export function breakStr(str, nb, endText = '', spBreak = false) {
  const source = String(str ?? '');
  const limit = Math.max(0, Math.floor(asFiniteNumber(nb, 0)));
  if (limit <= 0 || source.length <= limit) {
    return source;
  }

  let clipped = source.slice(0, limit);
  if (spBreak) {
    const spacePosition = clipped.lastIndexOf(' ');
    if (spacePosition > 0) {
      clipped = clipped.slice(0, spacePosition);
    }
  }

  return clipped + String(endText ?? '');
}

export function createHelpers() {
  return {
    money,
    number,
    dateTime,
    timeElapsed,
    timeDifference,
    breakStr,
    isObjectId,
    toObjectId,
  };
}

function fallbackSecret(length = 64) {
  const normalizedLength = Number.isFinite(Number(length)) && Number(length) > 0
    ? Math.floor(Number(length))
    : 64;
  return crypto.randomBytes(Math.ceil(normalizedLength / 2)).toString('hex').slice(0, normalizedLength);
}

function createUnavailableJlive(reason = 'jlive is not installed') {
  const fail = (methodName) => {
    const error = new Error(`jlive is unavailable. Install "jlive" to use "${methodName}".`);
    error.code = 'JLIVE_UNAVAILABLE';
    error.reason = reason;
    throw error;
  };

  return {
    available: false,
    reason,
    module: null,
    JliveEncrypt: null,
    generate: (length = 64) => fallbackSecret(length),
    encrypt: () => fail('encrypt'),
    decrypt: () => fail('decrypt'),
    hash: () => fail('hash'),
    verify: () => fail('verify'),
  };
}

function pickFunction(candidates, names) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    for (const name of names) {
      const fn = candidate[name];
      if (typeof fn === 'function') {
        return fn.bind(candidate);
      }
    }
  }
  return null;
}

function createAvailableJlive(loadedModule) {
  const moduleObject = loadedModule?.default ?? loadedModule;
  const jliveEncrypt = loadedModule?.JliveEncrypt
    || moduleObject?.JliveEncrypt
    || null;
  const candidates = [
    jliveEncrypt,
    moduleObject,
    loadedModule,
  ].filter(Boolean);

  const generateFn = pickFunction(candidates, ['generate', 'createSecret']);
  const encryptFn = pickFunction(candidates, ['encrypt']);
  const decryptFn = pickFunction(candidates, ['decrypt']);
  const hashFn = pickFunction(candidates, ['hash']);
  const verifyFn = pickFunction(candidates, ['verify', 'compare']);

  const fail = (methodName) => {
    const error = new Error(`jlive does not expose method "${methodName}" in this environment.`);
    error.code = 'JLIVE_METHOD_UNAVAILABLE';
    throw error;
  };

  return {
    available: true,
    reason: '',
    module: moduleObject,
    JliveEncrypt: jliveEncrypt,
    generate: (length = 64) => (generateFn ? generateFn(length) : fallbackSecret(length)),
    encrypt: (...args) => (encryptFn ? encryptFn(...args) : fail('encrypt')),
    decrypt: (...args) => (decryptFn ? decryptFn(...args) : fail('decrypt')),
    hash: (...args) => (hashFn ? hashFn(...args) : fail('hash')),
    verify: (...args) => (verifyFn ? verifyFn(...args) : fail('verify')),
  };
}

export async function loadJlive(logger = null) {
  try {
    const loadedModule = await import('jlive');
    return createAvailableJlive(loadedModule);
  } catch (error) {
    if (logger && typeof logger.debug === 'function') {
      logger.debug('jlive unavailable, using fallback bridge: %s', error?.message || String(error));
    }
    return createUnavailableJlive(error?.message || 'jlive import failed');
  }
}

export async function createRuntimeHelpers({ logger = null } = {}) {
  const helpers = createHelpers();
  const jlive = await loadJlive(logger);

  return {
    helpers,
    jlive,
  };
}

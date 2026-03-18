import nodemailer from 'nodemailer';

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

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

function isConfiguredTransport(value) {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  return isPlainObject(value) && Object.keys(value).length > 0;
}

function normalizeMailDefaults(rawDefaults, rawMail) {
  const defaults = isPlainObject(rawDefaults) ? rawDefaults : {};

  return {
    ...defaults,
    from: asNonEmptyString(defaults.from, asNonEmptyString(rawMail?.from)),
    replyTo: asNonEmptyString(defaults.replyTo, asNonEmptyString(rawMail?.replyTo)),
  };
}

export function normalizeMailConfig(rawMail) {
  if (rawMail === false || rawMail === null || rawMail === undefined) {
    return {
      enabled: false,
      defaults: {},
      transport: {},
      transportFactory: null,
      transporter: null,
      verifyOnStartup: false,
    };
  }

  const mail = isPlainObject(rawMail) ? rawMail : {};
  const transport = typeof mail.transport === 'string' && mail.transport.trim().length > 0
    ? mail.transport.trim()
    : isPlainObject(mail.transport)
      ? { ...mail.transport }
      : {};
  const transporter = mail.transporter && typeof mail.transporter.sendMail === 'function'
    ? mail.transporter
    : null;
  const transportFactory = typeof mail.transportFactory === 'function'
    ? mail.transportFactory
    : null;

  const enabled = mail.enabled === true
    || transporter !== null
    || transportFactory !== null
    || isConfiguredTransport(transport);

  return {
    enabled,
    defaults: normalizeMailDefaults(mail.defaults, mail),
    transport,
    transportFactory,
    transporter,
    verifyOnStartup: mail.verifyOnStartup === true,
  };
}

function createMailDisabledError() {
  const error = new Error('Mail is disabled. Enable settings.mail and configure a transport to send email.');
  error.code = 'AEGIS_MAIL_DISABLED';
  error.statusCode = 503;
  return error;
}

function normalizeEnvelopeField(value) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return null;
}

function listRecipients(payload) {
  return ['to', 'cc', 'bcc']
    .map((field) => normalizeEnvelopeField(payload[field]))
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []));
}

function buildMailPayload(message, mailConfig) {
  if (!isPlainObject(message)) {
    throw new Error('Mail payload must be an object.');
  }

  const payload = {
    ...mailConfig.defaults,
    ...message,
  };

  if (!payload.from && mailConfig.defaults.from) {
    payload.from = mailConfig.defaults.from;
  }

  if (!payload.replyTo && mailConfig.defaults.replyTo) {
    payload.replyTo = mailConfig.defaults.replyTo;
  }

  const hasRecipient = Boolean(
    normalizeEnvelopeField(payload.to)
    || normalizeEnvelopeField(payload.cc)
    || normalizeEnvelopeField(payload.bcc),
  );

  if (!hasRecipient) {
    throw new Error('Mail payload must include at least one recipient in "to", "cc", or "bcc".');
  }

  if (!payload.from) {
    throw new Error('Mail payload must include "from" or configure settings.mail.defaults.from.');
  }

  return payload;
}

async function resolveTransporter(mailConfig) {
  if (mailConfig.transporter) {
    return mailConfig.transporter;
  }

  if (mailConfig.transportFactory) {
    const created = await mailConfig.transportFactory(mailConfig);
    if (!created || typeof created.sendMail !== 'function') {
      throw new Error('settings.mail.transportFactory must return a transporter with sendMail().');
    }
    return created;
  }

  return nodemailer.createTransport(mailConfig.transport);
}

export async function createMailManager(rawMailConfig, logger) {
  const mailConfig = normalizeMailConfig(rawMailConfig);
  const runtimeLogger = logger && typeof logger.info === 'function'
    ? logger
    : { info() {} };

  if (!mailConfig.enabled) {
    const disabled = async () => {
      throw createMailDisabledError();
    };

    return {
      enabled: false,
      config: mailConfig,
      transporter: null,
      send: disabled,
      sendMail: disabled,
      verify: disabled,
      close: async () => {},
    };
  }

  const transporter = await resolveTransporter(mailConfig);

  if (mailConfig.verifyOnStartup && typeof transporter.verify === 'function') {
    await transporter.verify();
    runtimeLogger.info('Mail transport verified successfully.');
  }

  const send = async (message) => {
    const payload = buildMailPayload(message, mailConfig);
    const info = await transporter.sendMail(payload);
    const recipients = listRecipients(payload).join(', ') || '(none)';
    runtimeLogger.info(
      'Mail sent: messageId=%s to=%s',
      info?.messageId || '(none)',
      recipients,
    );
    return info;
  };

  const verify = async () => {
    if (typeof transporter.verify !== 'function') {
      return true;
    }

    return transporter.verify();
  };

  const close = async () => {
    if (typeof transporter.close === 'function') {
      await transporter.close();
    }
  };

  return {
    enabled: true,
    config: mailConfig,
    transporter,
    send,
    sendMail: send,
    verify,
    close,
  };
}

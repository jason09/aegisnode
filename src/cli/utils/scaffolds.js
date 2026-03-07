export function toPascalCase(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function renderAppEntries(apps, indent = '  ') {
  return apps
    .map((app) => `${indent}{ name: ${JSON.stringify(app.name)}, mount: ${JSON.stringify(app.mount)} },`)
    .join('\n');
}

export function renderProjectPackageJson(projectName) {
  return `${JSON.stringify(
    {
      name: projectName,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'aegisnode runserver',
        start: 'node app.js',
        test: 'node --test',
      },
      dependencies: {
        aegisnode: '^0.1.0',
      },
    },
    null,
    2,
  )}\n`;
}

export function renderProjectAppJs() {
  return `import { runProject } from 'aegisnode';

runProject({ rootDir: process.cwd() });
`;
}

export function renderProjectSettings(projectName, appSecret, apps) {
  return `export default {
  appName: '${projectName}',
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  security: {
    // Used to sign security tokens/cookies. Replace with a strong secret in production.
    appSecret: '${appSecret}',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  database: {
    enabled: false,
    dialect: 'pg',
    config: {},
    options: {},
  },
  cache: {
    enabled: true,
    driver: 'memory',
    options: {},
  },

  // Optional sections you can add manually when needed:
  // templates, i18n, helpers, staticDir, websocket, uploads, auth, api, swagger,
  // architecture, loaders, environments, security.headers/ddos/csrf

  apps: [
    // AEGIS_APPS_START
${renderAppEntries(apps, '    ')}
    // AEGIS_APPS_END
  ],
};
`;
}
export function renderSettingsApps(apps) {
  return `const apps = [
  // AEGIS_APPS_START
${renderAppEntries(apps, '  ')}
  // AEGIS_APPS_END
];

export default apps;
`;
}

export function renderProjectRoutes() {
  return `// AEGIS_APP_IMPORTS_START
// AEGIS_APP_IMPORTS_END

export default {
  register(route) {
    route.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });

    // AEGIS_PROJECT_APP_ROUTES_START
    // route.use('/users', users);
    // AEGIS_PROJECT_APP_ROUTES_END

    // Define your own homepage if you want to override the default confirmation page:
    // route.get('/', (req, res) => {
    //   return res.render('home', { title: 'Home' });
    // });
  },
};
`;
}

export function renderProjectGitIgnore() {
  return `node_modules
.env
.DS_Store
`;
}

export function renderEnvExample() {
  return `PORT=3000
LOG_LEVEL=info
NODE_ENV=development
`;
}

export function renderView(appName) {
  const className = `${toPascalCase(appName)}View`;
  return `class ${className} {
  static index(_context, req, res, next) {
    try {
      res.json({
        app: '${appName}',
        message: 'Hello from ${appName} view',
      });
    } catch (error) {
      if (typeof next === 'function') {
        next(error);
        return;
      }
      throw error;
    }
  }
}

export default ${className};
`;
}

export function renderController(appName) {
  return renderView(appName);
}

export function renderAppViewsFile(appName) {
  const className = `${toPascalCase(appName)}View`;
  return `class ${className} {
  static home(_context, req, res, next) {
    try {
      res.json({
        app: ${JSON.stringify(appName)},
        message: 'Hello from ${appName} view',
      });
    } catch (error) {
      next(error);
    }
  }

  static async index({ service }, req, res, next) {
    try {
      const data = await service.list();
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  static async create({ service, validator }, req, res, next) {
    try {
      const payload = validator.create(req.body || {});
      const created = await service.create(payload);
      res.status(201).json({ data: created });
    } catch (error) {
      next(error);
    }
  }

  static async read({ service, validator }, req, res, next) {
    try {
      const id = validator.id(req.params.id);
      const item = await service.getById(id);
      if (!item) {
        res.status(404).json({ error: 'Not Found' });
        return;
      }
      res.json({ data: item });
    } catch (error) {
      next(error);
    }
  }

  static async update({ service, validator }, req, res, next) {
    try {
      const id = validator.id(req.params.id);
      const payload = validator.update(req.body || {});
      const updated = await service.update(id, payload);
      if (!updated) {
        res.status(404).json({ error: 'Not Found' });
        return;
      }
      res.json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  static async remove({ service, validator }, req, res, next) {
    try {
      const id = validator.id(req.params.id);
      const removed = await service.remove(id);
      if (!removed) {
        res.status(404).json({ error: 'Not Found' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }
}

export default ${className};
`;
}

export function renderModel(appName) {
  const className = `${toPascalCase(appName)}Model`;
  return `class ${className} {
  constructor({ dbClient }) {
    this.dbClient = dbClient;
  }
}

export default ${className};
`;
}

export function renderService(appName) {
  const className = `${toPascalCase(appName)}Service`;
  return `class ${className} {
  constructor({ models }) {
    this.models = models;
  }
}

export default ${className};
`;
}

export function renderSubscriber(appName) {
  return `export default function register${toPascalCase(appName)}Subscribers({ events, logger }) {
  events.subscribe('app.booted', ({ appName }) => {
    logger.debug('[subscriber:${appName}] received app.booted for %s', appName);
  });
}
`;
}

export function renderAppModelsFile(appName) {
  const className = `${toPascalCase(appName)}Model`;
  return `const records = [];
let nextId = 1;

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'id' || typeof value === 'undefined') {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

class ${className} {
  constructor({ dbClient }) {
    this.dbClient = dbClient;
  }

  async list() {
    return records.map((entry) => ({ ...entry }));
  }

  async getById(id) {
    const record = records.find((entry) => entry.id === String(id));
    return record ? { ...record } : null;
  }

  async create(payload) {
    const entry = {
      id: String(nextId++),
      ...sanitizePayload(payload),
    };

    records.push(entry);
    return { ...entry };
  }

  async update(id, payload) {
    const targetId = String(id);
    const index = records.findIndex((entry) => entry.id === targetId);
    if (index < 0) {
      return null;
    }

    records[index] = {
      ...records[index],
      ...sanitizePayload(payload),
      id: targetId,
    };

    return { ...records[index] };
  }

  async remove(id) {
    const targetId = String(id);
    const index = records.findIndex((entry) => entry.id === targetId);
    if (index < 0) {
      return false;
    }

    records.splice(index, 1);
    return true;
  }
}

export default {
  ${JSON.stringify(appName)}: ${className},
};
`;
}

export function renderAppServicesFile(appName) {
  const className = `${toPascalCase(appName)}Service`;
  return `class ${className} {
  constructor({ models }) {
    this.model = models.get(${JSON.stringify(appName)});
  }

  async list() {
    return this.model.list();
  }

  async getById(id) {
    return this.model.getById(id);
  }

  async create(payload) {
    return this.model.create(payload);
  }

  async update(id, payload) {
    return this.model.update(id, payload);
  }

  async remove(id) {
    return this.model.remove(id);
  }
}

export default {
  ${JSON.stringify(appName)}: ${className},
};
`;
}

export function renderAppSubscribersFile(appName) {
  return `export default function register${toPascalCase(appName)}Subscribers({ events, logger }) {
  events.subscribe('app.booted', ({ appName }) => {
    logger.debug('[subscriber:${appName}] received app.booted for %s', appName);
  });
}
`;
}

export function renderAppValidatorsFile(appName) {
  const className = `${toPascalCase(appName)}Validator`;
  return `class ${className} {
  normalizePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('Payload must be an object.');
      error.statusCode = 400;
      throw error;
    }

    const normalized = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'id' || typeof value === 'undefined') {
        continue;
      }
      normalized[key] = value;
    }
    return normalized;
  }

  id(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      const error = new Error('Invalid resource identifier.');
      error.statusCode = 400;
      throw error;
    }
    return normalized;
  }

  create(payload) {
    return this.normalizePayload(payload);
  }

  update(payload) {
    return this.normalizePayload(payload);
  }
}

export default {
  ${JSON.stringify(appName)}: ${className},
};
`;
}

export function renderAppRoutes(appName) {
  const viewClass = `${toPascalCase(appName)}View`;
  return `import ${viewClass} from './views.js';

export default {
  appName: ${JSON.stringify(appName)},
  register(route) {
    route.get('/home', ${viewClass}.home);
    route.get('/', ${viewClass}.index);
    route.post('/', ${viewClass}.create);

    // AEGIS_APP_EXTRA_ROUTES_START
    // AEGIS_APP_EXTRA_ROUTES_END

    route.get('/:id', ${viewClass}.read);
    route.put('/:id', ${viewClass}.update);
    route.delete('/:id', ${viewClass}.remove);
  },
};
`;
}

export function renderAppModelTest(appName) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import models from '../models.js';

test('${appName} model exposes basic CRUD methods', async () => {
  const Model = models[${JSON.stringify(appName)}];
  assert.equal(typeof Model, 'function');

  const model = new Model({ dbClient: null });
  assert.equal(typeof model.list, 'function');
  assert.equal(typeof model.getById, 'function');
  assert.equal(typeof model.create, 'function');
  assert.equal(typeof model.update, 'function');
  assert.equal(typeof model.remove, 'function');

  const created = await model.create({ name: 'Alice' });
  assert.equal(created.name, 'Alice');

  const found = await model.getById(created.id);
  assert.equal(found?.name, 'Alice');
});
`;
}

export function renderAppValidatorTest(appName) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import validators from '../validators.js';

test('${appName} validator validates id and payload', () => {
  const Validator = validators[${JSON.stringify(appName)}];
  assert.equal(typeof Validator, 'function');

  const validator = new Validator();
  const payload = validator.create({ name: 'Alice', id: 'ignore-me' });
  assert.equal(payload.name, 'Alice');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'id'), false);

  assert.equal(validator.id('42'), '42');
  assert.throws(() => validator.id(''), /Invalid resource identifier/);
});
`;
}

export function renderAppServiceTest(appName) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import services from '../services.js';

test('${appName} service delegates to model layer', async () => {
  const Service = services[${JSON.stringify(appName)}];
  assert.equal(typeof Service, 'function');

  const fakeModel = {
    async list() {
      return [{ id: '1', name: 'Alice' }];
    },
    async getById(id) {
      return { id: String(id), name: 'Alice' };
    },
    async create(payload) {
      return { id: '2', ...payload };
    },
    async update(id, payload) {
      return { id: String(id), ...payload };
    },
    async remove() {
      return true;
    },
  };

  const service = new Service({
    models: {
      get(name) {
        assert.equal(name, ${JSON.stringify(appName)});
        return fakeModel;
      },
    },
  });

  const listed = await service.list();
  assert.equal(Array.isArray(listed), true);
  assert.equal(listed[0]?.name, 'Alice');
});
`;
}

export function renderAppRoutesTest(appName) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import routes from '../routes.js';

test('${appName} routes register expected CRUD endpoints', () => {
  const calls = [];
  const verbs = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use'];
  const route = {};

  for (const verb of verbs) {
    route[verb] = (routePath) => {
      calls.push(\`\${verb}:\${routePath}\`);
      return route;
    };
  }

  routes.register(route);

  assert.equal(calls.includes('get:/home'), true);
  assert.equal(calls.includes('get:/'), true);
  assert.equal(calls.includes('post:/'), true);
  assert.equal(calls.includes('get:/:id'), true);
  assert.equal(calls.includes('put:/:id'), true);
  assert.equal(calls.includes('delete:/:id'), true);
});
`;
}

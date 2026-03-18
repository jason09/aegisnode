import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { startProject } from '../src/cli/commands/startproject.js';
import { createApp } from '../src/cli/commands/createapp.js';
import { generateArtifact } from '../src/cli/commands/generate.js';
import { createKernel } from '../src/runtime/kernel.js';
import { runServer } from '../src/cli/commands/runserver.js';
import { runProject } from '../src/index.js';
import { createAuthManager, normalizeAuthConfig } from '../src/runtime/auth.js';
import { loadProjectConfig } from '../src/runtime/config.js';
import { initializeDatabase, closeDatabase } from '../src/runtime/database.js';
import { runDoctor } from '../src/cli/commands/doctor.js';
import { runUpdateDependencies } from '../src/cli/commands/updatedeps.js';
import { createHelpers } from '../src/runtime/helpers.js';

function createSilentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createFakeQueryMeshSqlClient() {
  const tables = new Map();
  const ensureTable = (name) => {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name);
  };

  return {
    schema() {
      return {
        createTable(name) {
          ensureTable(name);
          return {
            exec: async () => {},
          };
        },
      };
    },
    table(name) {
      return {
        select() {
          return {
            get: async () => [...ensureTable(name)],
          };
        },
        delete() {
          return {
            run: async () => {
              tables.set(name, []);
              return true;
            },
          };
        },
        insert(rows) {
          return {
            run: async () => {
              const payload = Array.isArray(rows)
                ? rows.map((entry) => ({ ...entry }))
                : [];
              tables.set(name, payload);
              return true;
            },
          };
        },
      };
    },
    dump(name) {
      return [...ensureTable(name)];
    },
  };
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkcePair() {
  const verifier = toBase64Url(crypto.randomBytes(48));
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  return {
    verifier,
    challenge,
  };
}

function requestHttps(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers,
      rejectUnauthorized: false,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body,
        });
      });
    });

    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisnode-'));
  const projectName = 'blog';
  const projectRoot = path.join(sandboxRoot, projectName);
  const frameworkRoot = path.resolve(process.cwd());
  const envSandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisnode-env-'));
  const dotenvSandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisnode-dotenv-'));
  const httpsSandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisnode-https-'));
  const proxySandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisnode-proxy-'));

  await startProject({ projectName, cwd: sandboxRoot });
  const generatedProjectEnv = await fs.readFile(path.join(projectRoot, '.env'), 'utf8');
  assert.match(generatedProjectEnv, /^APP_SECRET=.{16,}$/m);
  const generatedSettings = await fs.readFile(path.join(projectRoot, 'settings.js'), 'utf8');
  assert.match(generatedSettings, /appSecret:\s*process\.env\.APP_SECRET\s*\|\|\s*''/);
  await assert.rejects(
    () => runProject({
      rootDir: projectRoot,
      overrides: {
        host: '127.0.0.1',
        port: 0,
      },
    }),
    /started with "aegisnode runserver"/,
  );

  const envProjectName = 'envdemo';
  const envProjectRoot = path.join(envSandboxRoot, envProjectName);
  await startProject({ projectName: envProjectName, cwd: envSandboxRoot });
  await fs.writeFile(
    path.join(envProjectRoot, 'settings.js'),
    `export default {
  env: 'production',
  logging: {
    level: 'info',
  },
  security: {
    ddos: {
      maxRequests: 120,
    },
  },
  environments: {
    default: {
      security: {
        ddos: {
          windowMs: 45000,
        },
      },
    },
    production: {
      logging: { level: 'warn' },
      security: { ddos: { maxRequests: 80 } },
    },
  },
};
`,
    'utf8',
  );
  const envConfig = await loadProjectConfig(envProjectRoot);
  assert.equal(envConfig.env, 'production');
  assert.equal(envConfig.logging.level, 'warn');
  assert.equal(envConfig.security.ddos.windowMs, 45000);
  assert.equal(envConfig.security.ddos.maxRequests, 80);
  await assert.rejects(
    () => runServer({
      projectRoot: envProjectRoot,
      port: 0,
    }),
    /development mode/,
  );
  const productionProject = await runProject({
    rootDir: envProjectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
    },
  });
  await productionProject.stop();

  const dotenvProjectName = 'dotenvdemo';
  const dotenvProjectRoot = path.join(dotenvSandboxRoot, dotenvProjectName);
  await startProject({ projectName: dotenvProjectName, cwd: dotenvSandboxRoot });
  await fs.writeFile(
    path.join(dotenvProjectRoot, '.env'),
    `AEGIS_TEST_HOST=127.0.0.1
AEGIS_TEST_PORT=4321
AEGIS_TEST_LOG_LEVEL=warn
AEGIS_TEST_APP_SECRET=test-dotenv-secret
`,
    'utf8',
  );
  await fs.writeFile(
    path.join(dotenvProjectRoot, 'settings.js'),
    `export default {
  appName: 'dotenvdemo',
  host: process.env.AEGIS_TEST_HOST || '0.0.0.0',
  port: process.env.AEGIS_TEST_PORT ? Number(process.env.AEGIS_TEST_PORT) : 3000,
  security: {
    appSecret: process.env.AEGIS_TEST_APP_SECRET || '',
  },
  logging: {
    level: process.env.AEGIS_TEST_LOG_LEVEL || 'info',
  },
  apps: [],
};
`,
    'utf8',
  );
  const dotenvConfig = await loadProjectConfig(dotenvProjectRoot);
  assert.equal(dotenvConfig.host, '127.0.0.1');
  assert.equal(dotenvConfig.port, 4321);
  assert.equal(dotenvConfig.logging.level, 'warn');
  assert.equal(dotenvConfig.security.appSecret, 'test-dotenv-secret');

  const httpsProjectName = 'httpsdemo';
  const httpsProjectRoot = path.join(httpsSandboxRoot, httpsProjectName);
  await startProject({ projectName: httpsProjectName, cwd: httpsSandboxRoot });
  await fs.mkdir(path.join(httpsProjectRoot, 'certs'), { recursive: true });
  await fs.writeFile(
    path.join(httpsProjectRoot, 'certs', 'localhost-key.pem'),
    `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDC+P51c3EEyTG3
0oBSv5RuF/EakUD8lYgftczXyRZS2tidrLpUoEw3HRMV2yPsgMByFc8ctQPgTic5
dsUiiHid9ozl/S282i+AlrWE2xf4me9DoyC7ITQe15UBfxzqpB7ZXVrL/lQ6INgX
KkmSEeWY+/EyxyU/cDYwzFzru5TcPwOXL8ui09siYYOD75DEMufEh6v7k4zF+9nh
tixH8a3IRSr0MIW9WzBov1DNMRrdnG5P173Klc/4bh7eHrLk6vXC5Y6L3/B3PaVB
6idaeY6BwAGvL1Ik1yzIGQiPyZnpLZVir+wgiiRr4M56e1kjqsigWQR9S5VKGQUH
Sk2wccUhAgMBAAECggEAPKwTMyVrZBvf1t4whI+Ndv0IUEYnPPKjW4rNZdDzm3Dy
u45GpZMEZJotmD2LXktql5Xlz38c564qUp19FxP0xOM2UVOJ6hzTb2Z2shMj0H7G
j/uxccoRWA+qFL8jlnjgCLAeUyCfwT77P6ovHr9m/UZZdn22P5mBo4nU2J6U4jxG
ll2PZe8byL0bvZAmzVZ6a38Y7n4EjJIgfGGDCBojJedbrvEMO4U83OtOXUsWCepF
OZae3pNdHGuG8AJeUIcGYaUqAhe4/JEbJhkM9moQVLyLNSSAMknS50MeMO4pRWwJ
rA+iqCXyWNDXgaTNs02my6q1bxVfHH4aZeOMrMmjKQKBgQDnUvQs+KskRB9LLM2T
WReIQUP+m+s2y3+76CfEUjx7N4YG1jFRRId+grAyMHUcjbMopGi2aBxpEpveqzaH
/5ym7Ir4vZgOQ3MxRhKLnHGZprkKfi5Z/V4L18Mc9z1UHJql+wyXlazz9h1twwIO
R5AcI7nCrbaqwsACoGRKEN6V7wKBgQDXxVklj/4qB1hU+isy8xZBL4s46i1oGOEH
EoLXAYSNeL1QRhsuyoBj61Q+ac1mXI97GITKHMdVRsU6qAhMZnTbxVAe3Zk2LSMA
4qiyuHHd7J15Koe+WgKXTBh+gyDrWXlqEZXW8VY3YSltY4rf2+/EcijLvh+SKMkR
na3fEMvl7wKBgD9UUJD3SzNUixSzoVxTqcOdypWr7gtETyYMesaelPxOyRyaC0pq
boXOFZrH9Wfpy0C3MguuGQkTFSUyzm0RJ7vzSmCq1zQgdyroOi+Klvcv07zxqpLs
cJDhcwM9FMcwRY5nWp0tVvo7SPdByhBKu0NY7IRFtpqtUo/lhU9ZqvZ1AoGARNVN
MiF0eJ3tPPatz0wjHlp3dImoQJwnNWVfXg265pLM+g3TYCLzwGxzbJG+F9iRYTia
LAvwPzEbfDHcq9rHjtCsVZxl4xWVJBQqsxEKKjzwo5XAxiXay79X1Qwp9UqO5BqG
DZLh6TrSx3XI+M8l9ypf/1dApRTjx/3gWNf34/sCgYABb8Q1N2596ljMDezoiXBa
jnH0e+HEbacoxhF+zPkPhuCaHwQkkhFqDA4mdTwiTDbht68G8MLh5RBMDb6AGZ3h
L6OWwXt24ZYAs3GCFJWxiUdurw95Ce/UGBt8ShCHQqf5+8kGBZdQmX5yuyGPKEfK
8zvKq/Ke3FmfryEqANcGNg==
-----END PRIVATE KEY-----
`,
    'utf8',
  );
  await fs.writeFile(
    path.join(httpsProjectRoot, 'certs', 'localhost-cert.pem'),
    `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUKfS3Uua04vAtQ1Cqq5MhhIm3KnswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDMxNTE1NDQzOFoXDTI2MDMx
NjE1NDQzOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAwvj+dXNxBMkxt9KAUr+UbhfxGpFA/JWIH7XM18kWUtrY
nay6VKBMNx0TFdsj7IDAchXPHLUD4E4nOXbFIoh4nfaM5f0tvNovgJa1hNsX+Jnv
Q6MguyE0HteVAX8c6qQe2V1ay/5UOiDYFypJkhHlmPvxMsclP3A2MMxc67uU3D8D
ly/LotPbImGDg++QxDLnxIer+5OMxfvZ4bYsR/GtyEUq9DCFvVswaL9QzTEa3Zxu
T9e9ypXP+G4e3h6y5Or1wuWOi9/wdz2lQeonWnmOgcABry9SJNcsyBkIj8mZ6S2V
Yq/sIIoka+DOentZI6rIoFkEfUuVShkFB0pNsHHFIQIDAQABo1MwUTAdBgNVHQ4E
FgQU6TCiIGnLvsRYjRhBnjdSNu2oBKUwHwYDVR0jBBgwFoAU6TCiIGnLvsRYjRhB
njdSNu2oBKUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEALiwu
RULxP/LTqypp1sQmM1WsrUv/mfMoCCVmHOeEqljLOvtYKnVjPsS8ER90dfcTJQ6B
qJRNjWWDqnIFR90mkgBzVIp1JnV3kabShbhc+Gtd40qVEAzzXXV+PJgAIu/HjNp0
S5XWmSz2NNVwEEMqpIm2Aej/dDmSoD1Wvx5Z8PndHTAb8yP2gJM8oK/gE0g7o3gm
D2qu8eIsBibj/h99WhNApm4c39Sat1g9xl3dIe8xE0+hI12WtnyfuPj9TxDCai+r
0AIsvw3CSCUSwU4Cb/1zsHQ28IfSjbU3k7mbC79ja4MqZfEy/n6G1ZNV5FjapwVy
dkcqnJD4SGWVeG+KhA==
-----END CERTIFICATE-----
`,
    'utf8',
  );

  const httpsKernel = await createKernel({
    rootDir: httpsProjectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      https: {
        enabled: true,
        keyPath: 'certs/localhost-key.pem',
        certPath: 'certs/localhost-cert.pem',
      },
    },
  });

  await httpsKernel.start();
  const httpsAddress = httpsKernel.context.server.address();
  const httpsPort = typeof httpsAddress === 'object' && httpsAddress ? httpsAddress.port : 0;
  const httpsResponse = await requestHttps(`https://127.0.0.1:${httpsPort}/`);
  assert.equal(httpsResponse.status, 200);
  assert.match(httpsResponse.body, /Install Confirmed/);
  await httpsKernel.stop();

  const proxyProjectName = 'proxydemo';
  const proxyProjectRoot = path.join(proxySandboxRoot, proxyProjectName);
  await startProject({ projectName: proxyProjectName, cwd: proxySandboxRoot });
  await fs.writeFile(
    path.join(proxyProjectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.get('/secure-check', (req, res) => {\n      res.json({ secure: req.secure, protocol: req.protocol });\n    });\n  },\n};\n`,
    'utf8',
  );

  const proxyKernel = await createKernel({
    rootDir: proxyProjectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      trustProxy: 1,
    },
  });

  await proxyKernel.start();
  const proxyAddress = proxyKernel.context.server.address();
  const proxyPort = typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 0;
  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/secure-check`, {
    headers: {
      'x-forwarded-proto': 'https',
    },
  });
  const proxyJson = await proxyResponse.json();
  assert.equal(proxyJson.secure, true);
  assert.equal(proxyJson.protocol, 'https');
  await proxyKernel.stop();

  const helpers = createHelpers();
  const validObjectId = '507f1f77bcf86cd799439011';
  const invalidObjectId = 'not-an-object-id';

  assert.equal(helpers.isObjectId(validObjectId), true);
  assert.equal(helpers.isObjectId(invalidObjectId), false);
  const convertedObjectId = helpers.toObjectId(validObjectId);
  assert.ok(convertedObjectId);
  assert.equal(convertedObjectId.toString(), validObjectId);
  assert.equal(helpers.toObjectId(invalidObjectId), null);

  const fakeMongoConnection = {
    db: {
      collection() {
        return {};
      },
    },
  };

  const noSqlDb = await initializeDatabase({
    enabled: true,
    dialect: 'mongoose',
    config: {
      connection: fakeMongoConnection,
    },
  }, createSilentLogger());

  assert.equal(noSqlDb.type, 'nosql');
  assert.equal(noSqlDb.dialect, 'mongodb');
  assert.equal(typeof noSqlDb.client.table, 'function');

  const compiledMongoQuery = noSqlDb.client.table('users').select(['id', 'name']).compile();
  assert.equal(typeof compiledMongoQuery, 'object');

  await closeDatabase(noSqlDb);

  await fs.mkdir(path.join(projectRoot, 'node_modules'), { recursive: true });
  await fs.symlink(frameworkRoot, path.join(projectRoot, 'node_modules', 'aegisnode'), 'dir');

  const filesToCheck = [
    'app.js',
    'loader.cjs',
    'package.json',
    'settings.js',
    'routes.js',
  ];

  for (const relativeFile of filesToCheck) {
    const filePath = path.join(projectRoot, relativeFile);
    await fs.access(filePath);
  }

  const registryPackages = new Map([
    ['alpha', '2.0.0'],
    ['@scope/bravo', '3.4.0'],
    ['charlie', '5.0.0'],
    ['delta', '1.0.0'],
    ['echo', '1.1.0'],
    ['foxtrot', '8.0.0'],
  ]);
  const registryServer = http.createServer((request, response) => {
    const packageName = decodeURIComponent((request.url || '/').replace(/^\/+/, ''));
    const latestVersion = registryPackages.get(packageName);

    response.setHeader('content-type', 'application/json');

    if (!latestVersion) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    response.end(JSON.stringify({
      name: packageName,
      'dist-tags': {
        latest: latestVersion,
      },
    }));
  });
  await new Promise((resolve) => {
    registryServer.listen(0, '127.0.0.1', resolve);
  });
  const registryAddress = registryServer.address();
  assert.ok(registryAddress && typeof registryAddress === 'object');
  const registryBaseUrl = `http://127.0.0.1:${registryAddress.port}/`;

  try {
    await fs.writeFile(
      path.join(projectRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: projectName,
          version: '1.0.0',
          private: true,
          type: 'module',
          dependencies: {
            alpha: '^1.0.0',
            '@scope/bravo': '~3.2.1',
            localpkg: 'file:../localpkg',
            foxtrot: '^8.0.0',
          },
          devDependencies: {
            charlie: '4.0.0',
          },
          optionalDependencies: {
            echo: 'latest',
            aliasecho: 'npm:echo@^0.1.0',
          },
          peerDependencies: {
            delta: '^0.5.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const dependencyUpdateReport = await runUpdateDependencies({
      projectRoot,
      registryBaseUrl,
      installDependencies: false,
      output: {
        log() {},
      },
    });
    const updatedPackageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

    assert.equal(dependencyUpdateReport.rootDir, projectRoot);
    assert.equal(dependencyUpdateReport.packageManager, null);
    assert.equal(dependencyUpdateReport.updatedEntries.length, 6);
    assert.equal(dependencyUpdateReport.unchangedEntries.length, 1);
    assert.equal(dependencyUpdateReport.skippedEntries.length, 1);
    assert.equal(updatedPackageJson.dependencies.alpha, '^2.0.0');
    assert.equal(updatedPackageJson.dependencies['@scope/bravo'], '~3.4.0');
    assert.equal(updatedPackageJson.dependencies.localpkg, 'file:../localpkg');
    assert.equal(updatedPackageJson.dependencies.foxtrot, '^8.0.0');
    assert.equal(updatedPackageJson.devDependencies.charlie, '5.0.0');
    assert.equal(updatedPackageJson.optionalDependencies.echo, '1.1.0');
    assert.equal(updatedPackageJson.optionalDependencies.aliasecho, 'npm:echo@^1.1.0');
    assert.equal(updatedPackageJson.peerDependencies.delta, '^1.0.0');
  } finally {
    await new Promise((resolve) => {
      registryServer.close(resolve);
    });
  }

  await createApp({
    appName: 'users',
    projectRoot: sandboxRoot,
    mount: '/users',
  });

  await assert.rejects(
    () => createApp({
      appName: 'unsafe',
      projectRoot: sandboxRoot,
      mount: "/users');drop_table",
    }),
    /Invalid mount path segment/,
  );

  await fs.access(path.join(projectRoot, 'apps', 'users', 'routes.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'views.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'models.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'validators.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'services.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'subscribers.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'tests', 'models.test.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'tests', 'validators.test.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'tests', 'services.test.js'));
  await fs.access(path.join(projectRoot, 'apps', 'users', 'tests', 'routes.test.js'));
  const doctorReport = await runDoctor({
    projectRoot,
    failOnError: true,
    output: {
      log() {},
    },
  });
  assert.equal(doctorReport.summary.errors, 0);
  const projectRoutesFile = await fs.readFile(path.join(projectRoot, 'routes.js'), 'utf8');
  assert.match(projectRoutesFile, /route\.use\((['"])\/users\1, users\);/);
  await generateArtifact({
    type: 'view',
    name: 'profile',
    appName: 'users',
    projectRoot,
  });
  await fs.access(path.join(projectRoot, 'apps', 'users', 'profile.view.js'));
  await generateArtifact({
    type: 'validator',
    name: 'profile',
    appName: 'users',
    projectRoot,
  });
  await fs.access(path.join(projectRoot, 'apps', 'users', 'profile.validator.js'));
  await generateArtifact({
    type: 'dto',
    name: 'account',
    appName: 'users',
    projectRoot,
  });
  await fs.access(path.join(projectRoot, 'apps', 'users', 'account.validator.js'));
  await generateArtifact({
    type: 'route',
    name: 'profile',
    appName: 'users',
    projectRoot,
  });
  const usersRoutesFile = await fs.readFile(path.join(projectRoot, 'apps', 'users', 'routes.js'), 'utf8');
  assert.match(usersRoutesFile, /import ProfileView from '\.\/profile\.view\.js';/);
  assert.match(usersRoutesFile, /route\.get\('\/profile', ProfileView\.index\);/);
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'services.js'),
    `class UsersService {
  constructor({ models, mail }) {
    this.model = models.get('users');
    this.mail = mail;
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

  async sendSmokeMail() {
    return this.mail.send({
      to: 'user@example.com',
      subject: 'Smoke mail',
      html: '<p>mail transport ok</p>',
    });
  }
}

export default {
  users: UsersService,
};
`,
    'utf8',
  );
  const sentMail = [];
  const fakeTransporter = {
    async sendMail(message) {
      sentMail.push({ ...message });
      const accepted = Array.isArray(message.to) ? message.to : [message.to];
      return {
        messageId: `mail-${sentMail.length}`,
        accepted,
        rejected: [],
        envelope: {
          from: message.from,
          to: accepted,
        },
        response: '250 queued',
      };
    },
    async verify() {
      return true;
    },
    async close() {},
  };
  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `// AEGIS_APP_IMPORTS_START
import users from './apps/users/routes.js';
// AEGIS_APP_IMPORTS_END

export default {
  register(route) {
    route.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });

    route.get('/maintenance-page', (req, res) => {
      res.type('html').send('<!doctype html><html><body><h1>Custom maintenance route</h1><p>Temporarily offline.</p></body></html>');
    });

    route.get('/mail/send', async ({ mail, services }, req, res, next) => {
      try {
        const info = await services.forApp('users').get('users').sendSmokeMail();

        res.json({
          enabled: mail.enabled,
          viaReq: req.aegis.mail.enabled,
          sameBridge: req.aegis.mail === mail,
          from: info.envelope.from,
          accepted: info.accepted,
        });
      } catch (error) {
        next(error);
      }
    });

    // AEGIS_PROJECT_APP_ROUTES_START
    route.use("/users", users);
    // AEGIS_PROJECT_APP_ROUTES_END
  },
};
`,
    'utf8',
  );

  const maintenanceKernel = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      maintenance: {
        enabled: true,
        route: '/maintenance-page',
        excludePaths: ['/health'],
        retryAfter: 120,
      },
    },
  });
  await maintenanceKernel.start();
  const maintenanceAddress = maintenanceKernel.context.server.address();
  const maintenancePort = typeof maintenanceAddress === 'object' && maintenanceAddress ? maintenanceAddress.port : 0;
  const maintenanceUsersResponse = await fetch(`http://127.0.0.1:${maintenancePort}/users`);
  assert.equal(maintenanceUsersResponse.status, 503);
  assert.equal(maintenanceUsersResponse.headers.get('retry-after'), '120');
  assert.match(maintenanceUsersResponse.headers.get('content-type') || '', /text\/html/);
  const maintenanceHtml = await maintenanceUsersResponse.text();
  assert.match(maintenanceHtml, /Custom maintenance route/);
  const maintenanceHealthResponse = await fetch(`http://127.0.0.1:${maintenancePort}/health`);
  assert.equal(maintenanceHealthResponse.status, 200);
  const maintenanceHealthJson = await maintenanceHealthResponse.json();
  assert.equal(maintenanceHealthJson.status, 'ok');
  await maintenanceKernel.stop();

  const maintenanceFallbackKernel = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      maintenance: {
        enabled: true,
        route: '/missing-maintenance-route',
        excludePaths: ['/health'],
      },
    },
  });
  await maintenanceFallbackKernel.start();
  const maintenanceFallbackAddress = maintenanceFallbackKernel.context.server.address();
  const maintenanceFallbackPort = typeof maintenanceFallbackAddress === 'object' && maintenanceFallbackAddress
    ? maintenanceFallbackAddress.port
    : 0;
  const maintenanceFallbackResponse = await fetch(`http://127.0.0.1:${maintenanceFallbackPort}/users`);
  assert.equal(maintenanceFallbackResponse.status, 503);
  assert.match(maintenanceFallbackResponse.headers.get('content-type') || '', /text\/html/);
  const maintenanceFallbackHtml = await maintenanceFallbackResponse.text();
  assert.match(maintenanceFallbackHtml, /We&apos;ll be back soon\.|We'll be back soon\./);
  assert.match(maintenanceFallbackHtml, /Requested Path/);
  await maintenanceFallbackKernel.stop();

  const settingsFilePath = path.join(projectRoot, 'settings.js');
  const settingsBeforeUndeclaredCheck = await fs.readFile(settingsFilePath, 'utf8');
  const settingsWithoutUsers = settingsBeforeUndeclaredCheck.replace(
    /\s*\{\s*name:\s*['"]users['"]\s*,\s*mount:\s*['"]\/users['"]\s*\},?\n?/,
    '',
  );
  await fs.writeFile(settingsFilePath, settingsWithoutUsers, 'utf8');

  await assert.rejects(
    () => createKernel({
      rootDir: projectRoot,
      overrides: {
        host: '127.0.0.1',
        port: 0,
      },
    }),
    /settings\.apps/,
  );

  await fs.writeFile(settingsFilePath, settingsBeforeUndeclaredCheck, 'utf8');

  const kernel = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      mail: {
        enabled: true,
        defaults: {
          from: 'noreply@example.com',
        },
        transporter: fakeTransporter,
      },
    },
  });

  await kernel.start();
  const address = kernel.context.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const homeResponse = await fetch(`http://127.0.0.1:${port}/`);
  const homeText = await homeResponse.text();
  assert.match(homeText, /Install Confirmed/);
  assert.equal(homeResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(homeResponse.headers.get('content-security-policy') || '', /default-src/);
  const usersResponse = await fetch(`http://127.0.0.1:${port}/users`);
  const usersJson = await usersResponse.json();
  assert.equal(Array.isArray(usersJson.data), true);
  const usersCreateBlocked = await fetch(`http://127.0.0.1:${port}/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'blocked-without-csrf' }),
  });
  assert.equal(usersCreateBlocked.status, 403);
  const profileResponse = await fetch(`http://127.0.0.1:${port}/users/profile`);
  const profileJson = await profileResponse.json();
  assert.equal(profileJson.view, 'profile');
  const mailResponse = await fetch(`http://127.0.0.1:${port}/mail/send`);
  assert.equal(mailResponse.status, 200);
  const mailJson = await mailResponse.json();
  assert.equal(mailJson.enabled, true);
  assert.equal(mailJson.viaReq, true);
  assert.equal(mailJson.sameBridge, true);
  assert.equal(mailJson.from, 'noreply@example.com');
  assert.equal(mailJson.accepted[0], 'user@example.com');
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].from, 'noreply@example.com');
  assert.equal(sentMail[0].subject, 'Smoke mail');
  assert.equal(sentMail[0].html, '<p>mail transport ok</p>');
  await kernel.stop();

  const kernelWithApiApps = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      api: {
        apps: ['users'],
      },
    },
  });

  await kernelWithApiApps.start();
  const apiAddress = kernelWithApiApps.context.server.address();
  const apiPort = typeof apiAddress === 'object' && apiAddress ? apiAddress.port : 0;
  const usersCreateAllowed = await fetch(`http://127.0.0.1:${apiPort}/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'allowed-api-json' }),
  });
  assert.equal(usersCreateAllowed.status, 201);
  assert.equal(usersCreateAllowed.headers.get('cache-control'), 'no-store');
  const usersCreateAllowedJson = await usersCreateAllowed.json();
  assert.equal(usersCreateAllowedJson.data.name, 'allowed-api-json');

  const usersCreateInvalidContentType = await fetch(`http://127.0.0.1:${apiPort}/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ name: 'invalid-content-type' }),
  });
  assert.equal(usersCreateInvalidContentType.status, 415);
  await kernelWithApiApps.stop();

  const kernelWithSwagger = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      swagger: {
        enabled: true,
        document: {
          openapi: '3.0.3',
          info: {
            title: 'Smoke API',
            version: '1.0.0',
          },
          paths: {},
        },
      },
    },
  });

  await kernelWithSwagger.start();
  const swaggerAddress = kernelWithSwagger.context.server.address();
  const swaggerPort = typeof swaggerAddress === 'object' && swaggerAddress ? swaggerAddress.port : 0;

  const openApiResponse = await fetch(`http://127.0.0.1:${swaggerPort}/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  const openApiJson = await openApiResponse.json();
  assert.equal(openApiJson.openapi, '3.0.3');
  assert.equal(openApiJson.info.title, 'Smoke API');

  const swaggerUiResponse = await fetch(`http://127.0.0.1:${swaggerPort}/docs`);
  assert.equal(swaggerUiResponse.status, 200);
  const swaggerUiHtml = await swaggerUiResponse.text();
  assert.match(swaggerUiHtml, /Swagger UI/i);
  await kernelWithSwagger.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    const authGuard = (req, res, next) => req.aegis.auth.middleware()(req, res, next);\n\n    route.get('/auth/disabled-safe', authGuard, (req, res) => {\n      res.json({ ok: true });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithAuthDisabled = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      auth: {
        enabled: false,
      },
    },
  });

  await kernelWithAuthDisabled.start();
  const authDisabledAddress = kernelWithAuthDisabled.context.server.address();
  const authDisabledPort = typeof authDisabledAddress === 'object' && authDisabledAddress ? authDisabledAddress.port : 0;
  const authDisabledResponse = await fetch(`http://127.0.0.1:${authDisabledPort}/auth/disabled-safe`);
  assert.equal(authDisabledResponse.status, 503);
  await kernelWithAuthDisabled.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    const authGuard = (req, res, next) => req.aegis.auth.middleware()(req, res, next);\n\n    route.get('/jwt/token', (req, res) => {\n      const token = req.aegis.auth.issue({\n        subject: 'u1',\n        scope: ['read:users'],\n      });\n      const refreshToken = req.aegis.auth.issueRefreshToken({\n        subject: 'u1',\n      });\n      res.json({ token, refreshToken, tables: req.aegis.auth.tables });\n    });\n\n    route.get('/jwt/me', authGuard, (req, res) => {\n      res.json({ sub: req.auth.sub, scope: req.auth.scope || '' });\n    });\n\n    route.get('/jwt/revoke', (req, res) => {\n      const revoked = req.aegis.auth.revoke(req.query.token || '');\n      res.json({ revoked });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithJwtAuth = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      auth: {
        enabled: true,
        provider: 'jwt',
        tablePrefix: 'aegisnode',
        jwt: {
          secret: '0123456789abcdef0123456789abcdef',
        },
      },
    },
  });

  await kernelWithJwtAuth.start();
  const jwtAddress = kernelWithJwtAuth.context.server.address();
  const jwtPort = typeof jwtAddress === 'object' && jwtAddress ? jwtAddress.port : 0;
  const jwtTokenResponse = await fetch(`http://127.0.0.1:${jwtPort}/jwt/token`);
  assert.equal(jwtTokenResponse.status, 200);
  const jwtTokenJson = await jwtTokenResponse.json();
  assert.ok(typeof jwtTokenJson.token === 'string' && jwtTokenJson.token.length > 20);
  assert.match(jwtTokenJson.tables.oauthClients, /^aegisnode_/);

  const jwtMeResponse = await fetch(`http://127.0.0.1:${jwtPort}/jwt/me`, {
    headers: {
      authorization: `Bearer ${jwtTokenJson.token}`,
    },
  });
  assert.equal(jwtMeResponse.status, 200);
  const jwtMeJson = await jwtMeResponse.json();
  assert.equal(jwtMeJson.sub, 'u1');

  const jwtRevokeResponse = await fetch(`http://127.0.0.1:${jwtPort}/jwt/revoke?token=${encodeURIComponent(jwtTokenJson.token)}`);
  const jwtRevokeJson = await jwtRevokeResponse.json();
  assert.equal(jwtRevokeJson.revoked, true);

  const jwtAfterRevoke = await fetch(`http://127.0.0.1:${jwtPort}/jwt/me`, {
    headers: {
      authorization: `Bearer ${jwtTokenJson.token}`,
    },
  });
  assert.equal(jwtAfterRevoke.status, 401);
  await kernelWithJwtAuth.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    const authGuard = (req, res, next) => req.aegis.auth.middleware()(req, res, next);\n\n    route.get('/oauth/register', (req, res) => {\n      req.aegis.auth.registerClient({ clientId: 'web', clientSecret: 'secret' });\n      res.json({ ok: true, tables: req.aegis.auth.tables });\n    });\n\n    route.get('/oauth/token', (req, res) => {\n      const tokens = req.aegis.auth.issue({\n        clientId: 'web',\n        clientSecret: 'secret',\n        subject: 'u1',\n        scope: ['read:users'],\n      });\n      res.json(tokens);\n    });\n\n    route.get('/oauth/introspect', (req, res) => {\n      res.json(req.aegis.auth.introspect(req.query.token || ''));\n    });\n\n    route.get('/oauth/protected', authGuard, (req, res) => {\n      res.json({ sub: req.auth.sub || null, active: req.auth.active });\n    });\n\n    route.get('/oauth/revoke', (req, res) => {\n      const revoked = req.aegis.auth.revoke(req.query.token || '');\n      res.json({ revoked });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithOAuth2 = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      auth: {
        enabled: true,
        provider: 'oauth2',
        tablePrefix: 'aegisnode',
        storage: {
          driver: 'file',
          filePath: 'storage/aegisnode-auth-store.json',
        },
      },
    },
  });

  await kernelWithOAuth2.start();
  const oauthAddress = kernelWithOAuth2.context.server.address();
  const oauthPort = typeof oauthAddress === 'object' && oauthAddress ? oauthAddress.port : 0;
  const oauthRegisterResponse = await fetch(`http://127.0.0.1:${oauthPort}/oauth/register`);
  const oauthRegisterJson = await oauthRegisterResponse.json();
  assert.equal(oauthRegisterJson.ok, true);
  assert.match(oauthRegisterJson.tables.oauthAccessTokens, /^aegisnode_/);

  const oauthTokenResponse = await fetch(`http://127.0.0.1:${oauthPort}/oauth/token`);
  const oauthTokenJson = await oauthTokenResponse.json();
  assert.ok(typeof oauthTokenJson.accessToken === 'string' && oauthTokenJson.accessToken.length > 20);

  const oauthProtectedResponse = await fetch(`http://127.0.0.1:${oauthPort}/oauth/protected`, {
    headers: {
      authorization: `Bearer ${oauthTokenJson.accessToken}`,
    },
  });
  assert.equal(oauthProtectedResponse.status, 200);
  const oauthProtectedJson = await oauthProtectedResponse.json();
  assert.equal(oauthProtectedJson.sub, 'u1');

  const oauthIntrospectResponse = await fetch(`http://127.0.0.1:${oauthPort}/oauth/introspect?token=${encodeURIComponent(oauthTokenJson.accessToken)}`);
  const oauthIntrospectJson = await oauthIntrospectResponse.json();
  assert.equal(oauthIntrospectJson.active, true);
  await kernelWithOAuth2.stop();

  const kernelWithOAuth2Restarted = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      auth: {
        enabled: true,
        provider: 'oauth2',
        tablePrefix: 'aegisnode',
        storage: {
          driver: 'file',
          filePath: 'storage/aegisnode-auth-store.json',
        },
      },
    },
  });

  await kernelWithOAuth2Restarted.start();
  const oauthRestartedAddress = kernelWithOAuth2Restarted.context.server.address();
  const oauthRestartedPort = typeof oauthRestartedAddress === 'object' && oauthRestartedAddress ? oauthRestartedAddress.port : 0;
  const oauthIntrospectAfterRestartResponse = await fetch(`http://127.0.0.1:${oauthRestartedPort}/oauth/introspect?token=${encodeURIComponent(oauthTokenJson.accessToken)}`);
  const oauthIntrospectAfterRestartJson = await oauthIntrospectAfterRestartResponse.json();
  assert.equal(oauthIntrospectAfterRestartJson.active, true);

  const oauthRevokeResponse = await fetch(`http://127.0.0.1:${oauthRestartedPort}/oauth/revoke?token=${encodeURIComponent(oauthTokenJson.accessToken)}`);
  const oauthRevokeJson = await oauthRevokeResponse.json();
  assert.equal(oauthRevokeJson.revoked, true);

  const oauthProtectedAfterRevoke = await fetch(`http://127.0.0.1:${oauthRestartedPort}/oauth/protected`, {
    headers: {
      authorization: `Bearer ${oauthTokenJson.accessToken}`,
    },
  });
  assert.equal(oauthProtectedAfterRevoke.status, 401);
  await kernelWithOAuth2Restarted.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    const authGuard = (req, res, next) => req.aegis.auth.middleware()(req, res, next);\n\n    route.get('/oauth/server/register', (req, res) => {\n      const web = req.aegis.auth.registerClient({\n        clientId: 'web',\n        clientSecret: 'secret',\n        redirectUris: ['http://127.0.0.1/callback'],\n        grants: ['authorization_code', 'refresh_token'],\n        scopes: ['read:users'],\n      });\n\n      const machine = req.aegis.auth.registerClient({\n        clientId: 'machine',\n        clientSecret: 'machine-secret',\n        grants: ['client_credentials'],\n        scopes: ['read:users'],\n      });\n\n      res.json({ ok: true, web, machine });\n    });\n\n    route.get('/oauth/server/protected', authGuard, (req, res) => {\n      res.json({\n        active: req.auth.active,\n        sub: req.auth.sub || null,\n        clientId: req.auth.clientId || null,\n        tokenType: req.auth.tokenType,\n      });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithOAuthServer = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      auth: {
        enabled: true,
        provider: 'oauth2',
        oauth2: {
          server: {
            allowHttp: true,
            resolveSubject: () => 'u1',
          },
        },
      },
    },
  });

  await kernelWithOAuthServer.start();
  const oauthServerAddress = kernelWithOAuthServer.context.server.address();
  const oauthServerPort = typeof oauthServerAddress === 'object' && oauthServerAddress ? oauthServerAddress.port : 0;

  const oauthServerRegister = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/server/register`);
  const oauthServerRegisterJson = await oauthServerRegister.json();
  assert.equal(oauthServerRegisterJson.ok, true);
  assert.equal(oauthServerRegisterJson.web.clientId, 'web');

  const metadataResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/.well-known/oauth-authorization-server`);
  assert.equal(metadataResponse.status, 200);
  const metadataJson = await metadataResponse.json();
  assert.ok(String(metadataJson.authorization_endpoint || '').includes('/oauth/authorize'));
  assert.ok(String(metadataJson.token_endpoint || '').includes('/oauth/token'));

  const pkce = createPkcePair();
  const authorizeUrl = new URL(`http://127.0.0.1:${oauthServerPort}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', 'web');
  authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
  authorizeUrl.searchParams.set('scope', 'read:users');
  authorizeUrl.searchParams.set('state', 's123');
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const authorizeResponse = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorizeResponse.status, 302);
  const authorizeLocation = authorizeResponse.headers.get('location') || '';
  const authorizeRedirect = new URL(authorizeLocation);
  const authCode = authorizeRedirect.searchParams.get('code') || '';
  assert.ok(authCode.length > 20);
  assert.equal(authorizeRedirect.searchParams.get('state'), 's123');

  const tokenCodeResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: 'http://127.0.0.1/callback',
      client_id: 'web',
      client_secret: 'secret',
      code_verifier: pkce.verifier,
    }),
  });
  assert.equal(tokenCodeResponse.status, 200);
  const tokenCodeJson = await tokenCodeResponse.json();
  assert.ok(typeof tokenCodeJson.access_token === 'string' && tokenCodeJson.access_token.length > 20);
  assert.ok(typeof tokenCodeJson.refresh_token === 'string' && tokenCodeJson.refresh_token.length > 20);

  const oauthProtectedWithCodeToken = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/server/protected`, {
    headers: {
      authorization: `Bearer ${tokenCodeJson.access_token}`,
    },
  });
  assert.equal(oauthProtectedWithCodeToken.status, 200);
  const oauthProtectedWithCodeTokenJson = await oauthProtectedWithCodeToken.json();
  assert.equal(oauthProtectedWithCodeTokenJson.sub, 'u1');
  assert.equal(oauthProtectedWithCodeTokenJson.clientId, 'web');

  const webBasic = `Basic ${Buffer.from('web:secret').toString('base64')}`;
  const introspectCodeTokenResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/introspect`, {
    method: 'POST',
    headers: {
      authorization: webBasic,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      token: tokenCodeJson.access_token,
    }),
  });
  assert.equal(introspectCodeTokenResponse.status, 200);
  const introspectCodeTokenJson = await introspectCodeTokenResponse.json();
  assert.equal(introspectCodeTokenJson.active, true);
  assert.equal(introspectCodeTokenJson.client_id, 'web');

  const refreshExchangeResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: webBasic,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenCodeJson.refresh_token,
    }),
  });
  assert.equal(refreshExchangeResponse.status, 200);
  const refreshExchangeJson = await refreshExchangeResponse.json();
  assert.ok(typeof refreshExchangeJson.access_token === 'string' && refreshExchangeJson.access_token.length > 20);

  const revokeResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/revoke`, {
    method: 'POST',
    headers: {
      authorization: webBasic,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      token: refreshExchangeJson.access_token,
    }),
  });
  assert.equal(revokeResponse.status, 200);

  const introspectRevokedResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/introspect`, {
    method: 'POST',
    headers: {
      authorization: webBasic,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      token: refreshExchangeJson.access_token,
    }),
  });
  const introspectRevokedJson = await introspectRevokedResponse.json();
  assert.equal(introspectRevokedJson.active, false);

  const machineBasic = `Basic ${Buffer.from('machine:machine-secret').toString('base64')}`;
  const clientCredentialsTokenResponse = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: machineBasic,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'read:users',
    }),
  });
  assert.equal(clientCredentialsTokenResponse.status, 200);
  const clientCredentialsTokenJson = await clientCredentialsTokenResponse.json();
  assert.ok(typeof clientCredentialsTokenJson.access_token === 'string' && clientCredentialsTokenJson.access_token.length > 20);
  assert.equal(Object.prototype.hasOwnProperty.call(clientCredentialsTokenJson, 'refresh_token'), false);

  const oauthProtectedWithMachineToken = await fetch(`http://127.0.0.1:${oauthServerPort}/oauth/server/protected`, {
    headers: {
      authorization: `Bearer ${clientCredentialsTokenJson.access_token}`,
    },
  });
  assert.equal(oauthProtectedWithMachineToken.status, 200);
  const oauthProtectedWithMachineTokenJson = await oauthProtectedWithMachineToken.json();
  assert.equal(oauthProtectedWithMachineTokenJson.sub, null);
  assert.equal(oauthProtectedWithMachineTokenJson.clientId, 'machine');
  await kernelWithOAuthServer.stop();

  const authLogger = createSilentLogger();
  const fakeSqlClient = createFakeQueryMeshSqlClient();
  const authDatabaseConfig = normalizeAuthConfig({
    enabled: true,
    provider: 'oauth2',
    tablePrefix: 'aegisnode',
    storage: {
      driver: 'database',
    },
  }, {
    appName: 'blog',
    appSecret: '0123456789abcdef0123456789abcdef',
  });

  const authWithDbStorage = createAuthManager({
    config: authDatabaseConfig,
    cache: null,
    logger: authLogger,
    rootDir: projectRoot,
    database: {
      type: 'sql',
      client: fakeSqlClient,
    },
  });
  await authWithDbStorage.ready;
  authWithDbStorage.registerClient({
    clientId: 'api',
    clientSecret: 'secret',
  });
  const dbStorageTokens = authWithDbStorage.issue({
    clientId: 'api',
    clientSecret: 'secret',
    subject: 'u-db',
    scope: ['read:db'],
  });
  assert.equal(authWithDbStorage.introspect(dbStorageTokens.accessToken).active, true);
  await authWithDbStorage.close();

  const authWithDbStorageRestarted = createAuthManager({
    config: authDatabaseConfig,
    cache: null,
    logger: authLogger,
    rootDir: projectRoot,
    database: {
      type: 'sql',
      client: fakeSqlClient,
    },
  });
  await authWithDbStorageRestarted.ready;
  assert.equal(authWithDbStorageRestarted.introspect(dbStorageTokens.accessToken).active, true);
  assert.ok(fakeSqlClient.dump('aegisnode_auth_store').length > 0);
  await authWithDbStorageRestarted.close();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.get('/', (req, res) => {\n      res.send('custom-home');\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithCustomHome = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      security: {
        headers: {
          csp: {
            enabled: false,
          },
        },
      },
    },
  });

  await kernelWithCustomHome.start();
  const customAddress = kernelWithCustomHome.context.server.address();
  const customPort = typeof customAddress === 'object' && customAddress ? customAddress.port : 0;
  const customHomeResponse = await fetch(`http://127.0.0.1:${customPort}/`);
  const customHomeText = await customHomeResponse.text();
  assert.equal(customHomeText, 'custom-home');
  assert.equal(customHomeResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(customHomeResponse.headers.get('content-security-policy'), null);
  await kernelWithCustomHome.stop();

  await fs.mkdir(path.join(projectRoot, 'templates'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'templates', 'csrf-form.ejs'),
    '<form method="post" action="/submit"><%= csrfToken %></form>\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.get('/csrf-token', (req, res) => {\n      res.json({ token: req.csrfToken() });\n    });\n\n    route.get('/csrf-form', (req, res) => {\n      return res.render('csrf-form', { layout: false });\n    });\n\n    route.post('/submit', (req, res) => {\n      res.json({ ok: true, body: req.body || {} });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithCsrf = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
    },
  });

  await kernelWithCsrf.start();
  const csrfAddress = kernelWithCsrf.context.server.address();
  const csrfPort = typeof csrfAddress === 'object' && csrfAddress ? csrfAddress.port : 0;

  const csrfTokenResponse = await fetch(`http://127.0.0.1:${csrfPort}/csrf-token`);
  const csrfTokenJson = await csrfTokenResponse.json();
  const csrfCookieHeader = csrfTokenResponse.headers.get('set-cookie') || '';
  const csrfCookie = csrfCookieHeader.split(';')[0];
  assert.match(csrfCookie, /^_aegis_csrf=[a-f0-9]{64}\.[a-f0-9]{64}$/);
  assert.ok(typeof csrfTokenJson.token === 'string' && csrfTokenJson.token.length >= 32);

  const missingTokenResponse = await fetch(`http://127.0.0.1:${csrfPort}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
    },
    body: new URLSearchParams({ name: 'without-token' }),
  });
  assert.equal(missingTokenResponse.status, 403);

  const missingJsonTokenResponse = await fetch(`http://127.0.0.1:${csrfPort}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfCookie,
    },
    body: JSON.stringify({ name: 'json-without-token' }),
  });
  assert.equal(missingJsonTokenResponse.status, 403);

  const validTokenResponse = await fetch(`http://127.0.0.1:${csrfPort}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
    },
    body: new URLSearchParams({
      _csrf: csrfTokenJson.token,
      name: 'with-token',
    }),
  });
  assert.equal(validTokenResponse.status, 200);
  const validTokenJson = await validTokenResponse.json();
  assert.equal(validTokenJson.ok, true);
  assert.equal(validTokenJson.body.name, 'with-token');

  const validJsonTokenResponse = await fetch(`http://127.0.0.1:${csrfPort}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfCookie,
      'x-csrf-token': csrfTokenJson.token,
    },
    body: JSON.stringify({ name: 'json-with-token' }),
  });
  assert.equal(validJsonTokenResponse.status, 200);
  const validJsonTokenJson = await validJsonTokenResponse.json();
  assert.equal(validJsonTokenJson.ok, true);
  assert.equal(validJsonTokenJson.body.name, 'json-with-token');

  const csrfFormResponse = await fetch(`http://127.0.0.1:${csrfPort}/csrf-form`, {
    headers: {
      cookie: csrfCookie,
    },
  });
  const csrfFormHtml = await csrfFormResponse.text();
  assert.match(csrfFormHtml, /<input type="hidden" name="_csrf" value="[a-f0-9]{64}" \/>/);
  await kernelWithCsrf.stop();

  await fs.writeFile(
    path.join(projectRoot, 'templates', 'helpers.ejs'),
    '<div id="money"><%= money(amount, { currency: "USD" }) %></div>\n<div id="money2"><%= helpers.money(amount, { currency: "USD" }) %></div>\n<div id="elapsed"><%= timeElapsed(past, { now }) %></div>\n<div id="jlive"><%= typeof jlive.generate === "function" %></div>\n<div id="custom"><%= formatCurrency(amount) %></div>\n<div id="class"><%= new ViewBag("Dashboard").title %></div>\n',
    'utf8',
  );

  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'views.js'),
    `class UsersView {\n  constructor({ helpers, jlive }) {\n    this.helpers = helpers;\n    this.jlive = jlive;\n  }\n\n  index(req, res) {\n    res.json({\n      injectedMoney: this.helpers.money(55, { currency: 'USD' }),\n      jliveGenerateLength: this.jlive.generate(6).length,\n    });\n  }\n}\n\nexport default UsersView;\n`,
    'utf8',
  );

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.get('/helpers/json', (req, res) => {\n      res.json({\n        money: req.aegis.helpers.money(1234.5, { currency: 'USD' }),\n        elapsed: req.aegis.helpers.timeElapsed(Date.now() - 90_000, { now: Date.now() }),\n        elapsedShort: req.aegis.helpers.timeElapsed(Math.floor(Date.now() / 1000) - 90, true),\n        progress: req.aegis.helpers.timeDifference(50, 0, 100),\n        excerpt: req.aegis.helpers.breakStr('Aegis Node Framework', 10, '...', true),\n        generatedSecret: req.aegis.jlive.generate(24),\n        jliveAvailable: req.aegis.jlive.available,\n      });\n    });\n\n    route.get('/helpers/request', (req, res) => {\n      res.json({\n        fromReq: req.aegis.helpers.money(10, { currency: 'USD' }),\n        reqJliveSecretLength: req.aegis.jlive.generate(8).length,\n      });\n    });\n\n    route.get('/helpers/controller', 'users.views.index');\n\n    route.get('/helpers/view', (req, res) => {\n      return res.render('helpers', {\n        layout: false,\n        amount: 1234.5,\n        past: Date.now() - 90_000,\n        now: Date.now(),\n      });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithHelpers = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      templates: {
        locals: {
          formatCurrency: (value) => `$${Number(value || 0).toFixed(2)}`,
          ViewBag: class ViewBag {
            constructor(title) {
              this.title = title;
            }
          },
        },
      },
    },
  });

  assert.equal(typeof kernelWithHelpers.context.helpers?.money, 'function');
  assert.equal(typeof kernelWithHelpers.context.jlive?.generate, 'function');

  await kernelWithHelpers.start();
  const helpersAddress = kernelWithHelpers.context.server.address();
  const helpersPort = typeof helpersAddress === 'object' && helpersAddress ? helpersAddress.port : 0;

  const helpersJsonResponse = await fetch(`http://127.0.0.1:${helpersPort}/helpers/json`);
  assert.equal(helpersJsonResponse.status, 200);
  const helpersJson = await helpersJsonResponse.json();
  assert.equal(helpersJson.money, '$1,234.50');
  assert.match(helpersJson.elapsed, /(just now|minute|second|hour|day|week|month|year|ago|in )/i);
  assert.equal(typeof helpersJson.elapsedShort, 'string');
  assert.ok(helpersJson.elapsedShort.length > 0);
  assert.equal(helpersJson.progress, 50);
  assert.equal(helpersJson.excerpt, 'Aegis...');
  assert.equal(typeof helpersJson.generatedSecret, 'string');
  assert.equal(helpersJson.generatedSecret.length, 24);
  assert.equal(typeof helpersJson.jliveAvailable, 'boolean');

  const helpersReqResponse = await fetch(`http://127.0.0.1:${helpersPort}/helpers/request`);
  assert.equal(helpersReqResponse.status, 200);
  const helpersReqJson = await helpersReqResponse.json();
  assert.equal(helpersReqJson.fromReq, '$10.00');
  assert.equal(helpersReqJson.reqJliveSecretLength, 8);

  const helpersControllerResponse = await fetch(`http://127.0.0.1:${helpersPort}/helpers/controller`);
  assert.equal(helpersControllerResponse.status, 200);
  const helpersControllerJson = await helpersControllerResponse.json();
  assert.equal(helpersControllerJson.injectedMoney, '$55.00');
  assert.equal(helpersControllerJson.jliveGenerateLength, 6);

  const helpersViewResponse = await fetch(`http://127.0.0.1:${helpersPort}/helpers/view`);
  assert.equal(helpersViewResponse.status, 200);
  const helpersViewHtml = await helpersViewResponse.text();
  assert.match(helpersViewHtml, /<div id="money">\$1,234\.50<\/div>/);
  assert.match(helpersViewHtml, /<div id="money2">\$1,234\.50<\/div>/);
  assert.match(helpersViewHtml, /<div id="jlive">true<\/div>/);
  assert.match(helpersViewHtml, /<div id="custom">\$1234\.50<\/div>/);
  assert.match(helpersViewHtml, /<div id="class">Dashboard<\/div>/);
  await kernelWithHelpers.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.get('/limited', (req, res) => {\n      res.json({ ok: true });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithRateLimit = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      security: {
        ddos: {
          windowMs: 5000,
          maxRequests: 2,
          skipPaths: [],
        },
      },
    },
  });

  await kernelWithRateLimit.start();
  const rateLimitAddress = kernelWithRateLimit.context.server.address();
  const rateLimitPort = typeof rateLimitAddress === 'object' && rateLimitAddress ? rateLimitAddress.port : 0;

  const limitedOne = await fetch(`http://127.0.0.1:${rateLimitPort}/limited`);
  assert.equal(limitedOne.status, 200);
  const limitedTwo = await fetch(`http://127.0.0.1:${rateLimitPort}/limited`);
  assert.equal(limitedTwo.status, 200);
  const limitedThree = await fetch(`http://127.0.0.1:${rateLimitPort}/limited`);
  assert.equal(limitedThree.status, 429);
  const limitedThreeJson = await limitedThree.json();
  assert.equal(limitedThreeJson.error, 'Too many requests, please try again later.');
  await kernelWithRateLimit.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    const authGuard = (req, res, next) => {\n      if (req.headers['x-auth'] === 'ok') {\n        next();\n        return;\n      }\n      res.status(401).json({ error: 'Unauthorized' });\n    };\n\n    route.get('/secured', authGuard, (req, res) => {\n      res.json({ ok: true });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithMiddleware = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
    },
  });

  await kernelWithMiddleware.start();
  const middlewareAddress = kernelWithMiddleware.context.server.address();
  const middlewarePort = typeof middlewareAddress === 'object' && middlewareAddress ? middlewareAddress.port : 0;

  const securedDenied = await fetch(`http://127.0.0.1:${middlewarePort}/secured`);
  assert.equal(securedDenied.status, 401);

  const securedAllowed = await fetch(`http://127.0.0.1:${middlewarePort}/secured`, {
    headers: {
      'x-auth': 'ok',
    },
  });
  assert.equal(securedAllowed.status, 200);
  const securedAllowedJson = await securedAllowed.json();
  assert.equal(securedAllowedJson.ok, true);
  await kernelWithMiddleware.stop();

  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.post('/upload', route.upload.single('avatar'), (req, res) => {\n      if (!req.file) {\n        res.status(400).json({ error: 'No file uploaded' });\n        return;\n      }\n\n      res.json({\n        file: {\n          name: req.file.filename,\n          mimeType: req.file.mimetype,\n          size: req.file.size,\n        },\n      });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithUploads = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
      security: {
        csrf: {
          enabled: false,
        },
      },
      uploads: {
        enabled: true,
        dir: 'storage/uploads-test',
        maxFileSize: 64,
        allowedMimeTypes: ['text/plain'],
        allowedExtensions: ['.txt'],
      },
    },
  });

  await kernelWithUploads.start();
  const uploadAddress = kernelWithUploads.context.server.address();
  const uploadPort = typeof uploadAddress === 'object' && uploadAddress ? uploadAddress.port : 0;

  const uploadForm = new FormData();
  uploadForm.append('avatar', new Blob(['hello-upload'], { type: 'text/plain' }), 'avatar.txt');
  const uploadOk = await fetch(`http://127.0.0.1:${uploadPort}/upload`, {
    method: 'POST',
    body: uploadForm,
  });
  assert.equal(uploadOk.status, 200);
  const uploadOkJson = await uploadOk.json();
  assert.equal(uploadOkJson.file.mimeType, 'text/plain');
  assert.equal(typeof uploadOkJson.file.name, 'string');

  const uploadMimeForm = new FormData();
  uploadMimeForm.append('avatar', new Blob(['png-content'], { type: 'image/png' }), 'avatar.png');
  const uploadMimeRejected = await fetch(`http://127.0.0.1:${uploadPort}/upload`, {
    method: 'POST',
    body: uploadMimeForm,
  });
  assert.equal(uploadMimeRejected.status, 415);

  const uploadSizeForm = new FormData();
  uploadSizeForm.append('avatar', new Blob(['x'.repeat(256)], { type: 'text/plain' }), 'big.txt');
  const uploadTooLarge = await fetch(`http://127.0.0.1:${uploadPort}/upload`, {
    method: 'POST',
    body: uploadSizeForm,
  });
  assert.equal(uploadTooLarge.status, 413);
  await kernelWithUploads.stop();

  await assert.rejects(
    () => createKernel({
      rootDir: projectRoot,
      overrides: {
        host: '127.0.0.1',
        port: 0,
        security: {
          csrf: {
            enabled: false,
          },
        },
        uploads: {
          enabled: false,
        },
      },
    }),
    /Uploads are disabled/,
  );

  const settingsFile = path.join(projectRoot, 'settings.js');
  const settingsBeforeStrict = await fs.readFile(settingsFile, 'utf8');
  const settingsWithStrictLayers = settingsBeforeStrict.replace(
    /\n\s*apps:\s*\[/,
    "\n  architecture: {\n    strictLayers: true,\n  },\n  autoMountApps: true,\n  apps: [",
  );
  await fs.writeFile(settingsFile, settingsWithStrictLayers, 'utf8');

  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'models.js'),
    `class UsersModel {\n  constructor({ dbClient }) {\n    this.dbClient = dbClient;\n  }\n\n  async list() {\n    return [{ id: 1, name: 'alice' }];\n  }\n}\n\nexport default {\n  users: UsersModel,\n};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'services.js'),
    `class UsersService {\n  constructor({ models }) {\n    this.usersModel = models.get('users');\n  }\n\n  async list() {\n    return this.usersModel.list();\n  }\n}\n\nexport default {\n  users: UsersService,\n};\n`,
    'utf8',
  );
  const strictUsersRoutes = `import UsersView from './views.js';\n\nexport default {\n  appName: 'users',\n  register(route) {\n    route.get('/', UsersView.index);\n\n    // AEGIS_APP_EXTRA_ROUTES_START\n    // AEGIS_APP_EXTRA_ROUTES_END\n  },\n};\n`;
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'routes.js'),
    strictUsersRoutes,
    'utf8',
  );
  const kernelWithStrictLayers = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
    },
  });

  await kernelWithStrictLayers.start();
  const strictAddress = kernelWithStrictLayers.context.server.address();
  const strictPort = typeof strictAddress === 'object' && strictAddress ? strictAddress.port : 0;
  const strictUsersResponse = await fetch(`http://127.0.0.1:${strictPort}/users`);
  assert.equal(strictUsersResponse.status, 200);
  const strictUsersJson = await strictUsersResponse.json();
  assert.equal(Array.isArray(strictUsersJson.data), true);
  assert.equal(strictUsersJson.data[0].name, 'alice');
  await kernelWithStrictLayers.stop();

  await fs.appendFile(path.join(projectRoot, '.env'), '\nAEGIS_LAYER_ENV_TEST=from-dotenv\n', 'utf8');
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'models.js'),
    `class UsersModel {\n  constructor({ env }) {\n    this.env = env;\n  }\n\n  async list() {\n    return [{ id: 1, name: 'alice', modelEnv: this.env.AEGIS_LAYER_ENV_TEST || null }];\n  }\n}\n\nexport default {\n  users: UsersModel,\n};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'services.js'),
    `class UsersService {\n  constructor({ models, env }) {\n    this.usersModel = models.get('users');\n    this.env = env;\n  }\n\n  async list() {\n    const users = await this.usersModel.list();\n    return users.map((user) => ({ ...user, serviceEnv: this.env.AEGIS_LAYER_ENV_TEST || null }));\n  }\n}\n\nexport default {\n  users: UsersService,\n};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'views.js'),
    `class UsersView {\n  async index({ service, env }, req, res, next) {\n    try {\n      const data = await service.list();\n      res.json({\n        viewEnv: env.AEGIS_LAYER_ENV_TEST || null,\n        data,\n      });\n    } catch (error) {\n      next(error);\n    }\n  }\n}\n\nexport default UsersView;\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'routes.js'),
    `export default {\n  appName: 'users',\n  register(route) {\n    route.get('/', 'users.views.index');\n  },\n};\n`,
    'utf8',
  );

  const kernelWithInjectedEnv = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
    },
  });

  await kernelWithInjectedEnv.start();
  const injectedEnvAddress = kernelWithInjectedEnv.context.server.address();
  const injectedEnvPort = typeof injectedEnvAddress === 'object' && injectedEnvAddress ? injectedEnvAddress.port : 0;
  const injectedEnvResponse = await fetch(`http://127.0.0.1:${injectedEnvPort}/users`);
  assert.equal(injectedEnvResponse.status, 200);
  const injectedEnvJson = await injectedEnvResponse.json();
  assert.equal(injectedEnvJson.viewEnv, 'from-dotenv');
  assert.equal(injectedEnvJson.data[0].serviceEnv, 'from-dotenv');
  assert.equal(injectedEnvJson.data[0].modelEnv, 'from-dotenv');
  await kernelWithInjectedEnv.stop();

  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'routes.js'),
    `import Models from './models.js';\n\nexport default {\n  appName: 'users',\n  register(route) {\n    route.get('/', async (req, res, next) => {\n      try {\n        const model = new Models.users({ dbClient: null });\n        const users = await model.list();\n        res.json({ users });\n      } catch (error) {\n        next(error);\n      }\n    });\n  },\n};\n`,
    'utf8',
  );
  await assert.rejects(
    () => createKernel({
      rootDir: projectRoot,
      overrides: {
        host: '127.0.0.1',
        port: 0,
      },
    }),
    /strictLayers.*Routes in app "users" must call services only/,
  );
  await fs.writeFile(path.join(projectRoot, 'apps', 'users', 'routes.js'), strictUsersRoutes, 'utf8');

  const currentSettings = await fs.readFile(settingsFile, 'utf8');
  const updatedSettings = currentSettings.replace(
    /\n\s*apps:\s*\[/,
    "\n  templates: {\n    dir: 'ui',\n  },\n  i18n: {\n    enabled: true,\n    defaultLocale: 'en',\n    fallbackLocale: 'en',\n    supported: ['en', 'fr'],\n    translations: {\n      en: 'locales/en.json',\n      fr: 'locales/fr.json',\n    },\n  },\n  apps: [",
  );
  await fs.writeFile(settingsFile, updatedSettings, 'utf8');

  await fs.mkdir(path.join(projectRoot, 'locales'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'locales', 'en.json'),
    JSON.stringify({
      home: {
        pageTitle: 'Template Test',
        title: 'Welcome {name}',
      },
    }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'locales', 'fr.json'),
    JSON.stringify({
      home: {
        pageTitle: 'Test de template',
        title: 'Bienvenue {name}',
      },
    }, null, 2),
    'utf8',
  );

  await fs.mkdir(path.join(projectRoot, 'ui'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'ui', 'base.ejs'),
    '<!doctype html><html><head><title><%= title %></title></head><body><main><%- content %></main></body></html>\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'ui', 'home.ejs'),
    '<h1><%= t("home.title", { name: "Aegis" }) %></h1>\n<p><%= locale %></p>\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'models.js'),
    `class UsersModel {\n  constructor({ i18n }) {\n    this.i18n = i18n;\n  }\n\n  greeting(name) {\n    return this.i18n.t('home.title', { name });\n  }\n}\n\nexport default {\n  users: UsersModel,\n};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'services.js'),
    `class UsersService {\n  constructor({ models, i18n }) {\n    this.usersModel = models.get('users');\n    this.i18n = i18n;\n  }\n\n  greetings() {\n    return {\n      service: this.i18n.t('home.title', { name: 'Service' }),\n      model: this.usersModel.greeting('Model'),\n    };\n  }\n}\n\nexport default {\n  users: UsersService,\n};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'validators.js'),
    `class UsersValidator {\n  constructor({ i18n }) {\n    this.i18n = i18n;\n  }\n\n  greeting(name) {\n    return this.i18n.t('home.title', { name });\n  }\n}\n\nexport default {\n  users: UsersValidator,\n};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'apps', 'users', 'subscribers.js'),
    `export default function registerUsersSubscribers({ appName, cache, events, i18n }) {\n  events.subscribe('app.booted', ({ appName: bootedAppName }) => {\n    if (bootedAppName !== appName) {\n      return;\n    }\n\n    cache.set('users.subscriber.greeting', i18n.t('home.title', { name: 'Subscriber' }));\n  });\n}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, 'routes.js'),
    `export default {\n  register(route) {\n    route.get('/i18n/json', (req, res) => {\n      res.json({\n        locale: req.aegis.locale,\n        hello: req.aegis.t('home.title', { name: 'Aegis' }),\n      });\n    });\n\n    route.get('/i18n/layers', (req, res) => {\n      const usersService = req.aegis.services.forApp('users').get('users');\n      const layers = usersService.greetings();\n      res.json({\n        locale: req.aegis.locale,\n        requestHello: req.aegis.i18n.t('home.title', { name: 'Request' }),\n        serviceHello: layers.service,\n        modelHello: layers.model,\n      });\n    });\n\n    route.get('/i18n/injected', ({ cache, i18n, validators }, req, res, next) => {\n      try {\n        const usersValidator = validators.forApp('users').get('users');\n        res.json({\n          locale: req.aegis.locale,\n          viewHello: i18n.t('home.title', { name: 'View' }),\n          validatorHello: usersValidator.greeting('Validator'),\n          subscriberHello: cache.get('users.subscriber.greeting'),\n        });\n      } catch (error) {\n        next(error);\n      }\n    });\n\n    route.get('/', (req, res) => {\n      return res.render('home', {\n        title: req.aegis.t('home.pageTitle'),\n      });\n    });\n  },\n};\n`,
    'utf8',
  );

  const kernelWithTemplates = await createKernel({
    rootDir: projectRoot,
    overrides: {
      host: '127.0.0.1',
      port: 0,
    },
  });

  await kernelWithTemplates.start();
  const templateAddress = kernelWithTemplates.context.server.address();
  const templatePort = typeof templateAddress === 'object' && templateAddress ? templateAddress.port : 0;
  const directLayerGreetings = kernelWithTemplates.context.services.forApp('users').get('users').greetings();
  assert.equal(directLayerGreetings.service, 'Welcome Service');
  assert.equal(directLayerGreetings.model, 'Welcome Model');
  const templateResponse = await fetch(`http://127.0.0.1:${templatePort}/`, {
    headers: {
      'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
  });
  const templateHtml = await templateResponse.text();
  assert.match(templateHtml, /<title>Test de template<\/title>/);
  assert.match(templateHtml, /Bienvenue Aegis/);
  assert.match(templateHtml, /<p>fr<\/p>/);

  const i18nJsonResponse = await fetch(`http://127.0.0.1:${templatePort}/i18n/json?lang=fr`);
  assert.equal(i18nJsonResponse.status, 200);
  const i18nJson = await i18nJsonResponse.json();
  assert.equal(i18nJson.locale, 'fr');
  assert.equal(i18nJson.hello, 'Bienvenue Aegis');

  const i18nLayerResponse = await fetch(`http://127.0.0.1:${templatePort}/i18n/layers?lang=fr`);
  assert.equal(i18nLayerResponse.status, 200);
  const i18nLayers = await i18nLayerResponse.json();
  assert.equal(i18nLayers.locale, 'fr');
  assert.equal(i18nLayers.requestHello, 'Bienvenue Request');
  assert.equal(i18nLayers.serviceHello, 'Bienvenue Service');
  assert.equal(i18nLayers.modelHello, 'Bienvenue Model');

  const i18nInjectedResponse = await fetch(`http://127.0.0.1:${templatePort}/i18n/injected?lang=fr`);
  assert.equal(i18nInjectedResponse.status, 200);
  const i18nInjected = await i18nInjectedResponse.json();
  assert.equal(i18nInjected.locale, 'fr');
  assert.equal(i18nInjected.viewHello, 'Bienvenue View');
  assert.equal(i18nInjected.validatorHello, 'Bienvenue Validator');
  assert.equal(i18nInjected.subscriberHello, 'Welcome Subscriber');
  await kernelWithTemplates.stop();

  const kernelFromParent = await runServer({
    projectRoot: sandboxRoot,
    port: 0,
  });

  const parentAddress = kernelFromParent.context.server.address();
  const parentPort = typeof parentAddress === 'object' && parentAddress ? parentAddress.port : 0;
  const parentRootResponse = await fetch(`http://127.0.0.1:${parentPort}/`);
  const parentRootText = await parentRootResponse.text();
  assert.match(parentRootText, /Welcome Aegis/);
  await kernelFromParent.stop();

  assert.ok(true, 'Smoke test completed');

  await fs.rm(sandboxRoot, { recursive: true, force: true });
  await fs.rm(envSandboxRoot, { recursive: true, force: true });
  await fs.rm(dotenvSandboxRoot, { recursive: true, force: true });
  await fs.rm(httpsSandboxRoot, { recursive: true, force: true });
  await fs.rm(proxySandboxRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

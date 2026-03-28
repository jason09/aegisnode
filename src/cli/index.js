import { startProject } from './commands/startproject.js';
import { createApp } from './commands/createapp.js';
import { runServer } from './commands/runserver.js';
import { generateArtifact } from './commands/generate.js';
import { runDoctor } from './commands/doctor.js';
import { runUpdateDependencies } from './commands/updatedeps.js';
import { runGenerateLoader } from './commands/generateloader.js';

function printHelp() {
  console.log(`AegisNode CLI

Usage:
  aegisnode startproject <project-name>
  aegisnode createapp <app-name> [--project <path>] [--mount </path>]
  aegisnode generate <type> <name> --app <app-name> [--project <path>]
  aegisnode runserver [--project <path>] [--port <number>]
  aegisnode generateloader [--project <path>]
  aegisnode doctor [--project <path>]
  aegisnode updatedeps [--project <path>]

Examples:
  aegisnode startproject blog
  cd blog
  npm install
  aegisnode runserver
  aegisnode createapp users
  aegisnode generate view user --app users
  aegisnode generate validator user --app users
  aegisnode generateloader --project blog
  aegisnode updatedeps --project blog
`);
}

function parseFlags(tokens) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    if (token === '-p' || token === '--port') {
      flags.port = tokens[index + 1];
      index += 1;
      continue;
    }

    if (token === '--project') {
      flags.project = tokens[index + 1];
      index += 1;
      continue;
    }

    if (token === '--mount') {
      flags.mount = tokens[index + 1];
      index += 1;
      continue;
    }

    if (token === '--app') {
      flags.app = tokens[index + 1];
      index += 1;
      continue;
    }

    if (token === '-h' || token === '--help') {
      flags.help = true;
      continue;
    }

    throw new Error(`Unknown flag: ${token}`);
  }

  return { flags, positional };
}

export async function runCli(argv) {
  if (!argv.length) {
    printHelp();
    return;
  }

  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  if (flags.help || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'startproject': {
      const [projectName] = positional;
      if (!projectName) {
        throw new Error('Missing project name. Usage: aegisnode startproject <project-name>');
      }
      await startProject({ projectName, cwd: process.cwd() });
      return;
    }

    case 'createapp': {
      const [appName] = positional;
      if (!appName) {
        throw new Error('Missing app name. Usage: aegisnode createapp <app-name>');
      }
      await createApp({
        appName,
        projectRoot: flags.project ? String(flags.project) : process.cwd(),
        mount: flags.mount ? String(flags.mount) : undefined,
      });
      return;
    }

    case 'runserver': {
      await runServer({
        projectRoot: flags.project ? String(flags.project) : process.cwd(),
        port: flags.port ? Number(flags.port) : undefined,
      });
      return;
    }

    case 'doctor': {
      await runDoctor({
        projectRoot: flags.project ? String(flags.project) : process.cwd(),
      });
      return;
    }

    case 'generateloader':
    case 'loader': {
      await runGenerateLoader({
        projectRoot: flags.project ? String(flags.project) : process.cwd(),
      });
      return;
    }

    case 'updatedeps': {
      await runUpdateDependencies({
        projectRoot: flags.project ? String(flags.project) : process.cwd(),
      });
      return;
    }

    case 'generate':
    case 'g': {
      const [type, name] = positional;
      await generateArtifact({
        type,
        name,
        appName: flags.app ? String(flags.app) : undefined,
        projectRoot: flags.project ? String(flags.project) : process.cwd(),
      });
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

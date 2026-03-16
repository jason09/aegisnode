import { runProject } from '../../index.js';
import { resolveProjectRoot } from '../utils/project.js';

export async function runServer({ projectRoot, port }) {
  const resolvedRoot = await resolveProjectRoot(projectRoot);
  const overrides = {};

  if (Number.isFinite(port) && port >= 0) {
    overrides.port = Number(port);
  }

  return runProject({
    rootDir: resolvedRoot,
    overrides,
    startupSource: 'runserver',
  });
}

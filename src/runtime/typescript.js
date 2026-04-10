import { pathToFileURL } from 'url';
import { isTypeScriptFile } from '../utils/source-files.js';

let registrationPromise = null;

export async function registerTypeScriptRuntime() {
  if (!registrationPromise) {
    registrationPromise = import('tsx/esm/api').then(({ register }) => register());
  }

  return registrationPromise;
}

export async function importProjectModule(filePath) {
  if (isTypeScriptFile(filePath)) {
    await registerTypeScriptRuntime();
  }

  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

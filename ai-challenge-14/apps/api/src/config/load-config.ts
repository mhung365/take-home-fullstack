import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type ConfigIssue, type LoadedConfig } from '@claims/engine';

export interface ConfigPaths {
  workflow: string;
  users: string;
}

/** Relative paths in env are resolved against the working directory. */
export function configPaths(defaultDir: string): ConfigPaths {
  return {
    workflow: resolve(process.env.WORKFLOW_CONFIG_PATH ?? resolve(defaultDir, 'claims-workflow.json')),
    users: resolve(process.env.USERS_CONFIG_PATH ?? resolve(defaultDir, 'users.json')),
  };
}

/** Throws on unreadable files, invalid JSON, or ConfigValidationError listing every issue. */
export function loadConfigFiles(paths: ConfigPaths): LoadedConfig & { warnings: ConfigIssue[] } {
  return loadConfig({ workflow: readJson(paths.workflow), users: readJson(paths.users) });
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Config file ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

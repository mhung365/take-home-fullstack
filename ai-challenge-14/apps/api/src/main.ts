import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { formatIssue, type LoadedConfig } from '@claims/engine';
import { readPostgresEnv, type PostgresEnv } from '@claims/store-postgres';
import { AppModule } from './app.module';
import { configPaths, loadConfigFiles } from './config/load-config';

const logger = new Logger('Bootstrap');

// main.js sits in apps/api/dist, so the repo root is three levels up. Variables already set in the environment win.
const envFile = resolve(__dirname, '..', '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function readDatabaseEnvOrExit(): PostgresEnv {
  try {
    const env = readPostgresEnv();
    const { host, pathname } = new URL(env.databaseUrl);
    logger.log(`Database ${host}${pathname}, pool max ${env.poolMax}, lock timeout ${env.lockTimeoutMs}ms`);
    return env;
  } catch (error) {
    logger.error((error as Error).message);
    process.exit(1);
  }
}

function loadConfigOrExit(): LoadedConfig {
  // main.js sits in apps/api/dist, so the repo's config/ is three levels up.
  const paths = configPaths(resolve(__dirname, '..', '..', '..', 'config'));
  try {
    const { warnings, ...config } = loadConfigFiles(paths);
    for (const warning of warnings) logger.warn(formatIssue(warning));
    logger.log(`Loaded workflow ${paths.workflow} and users ${paths.users}`);
    return config;
  } catch (error) {
    logger.error((error as Error).message);
    process.exit(1);
  }
}

async function bootstrap() {
  const config = loadConfigOrExit();
  const database = readDatabaseEnvOrExit();
  const demoMode = process.env.DEMO_MODE === 'true';
  if (demoMode) logger.warn('DEMO_MODE=true: POST /dev/clock/advance is enabled');
  const app = await NestFactory.create(AppModule.forRoot(config, { demoMode, database }));
  app.enableShutdownHooks();
  app.enableCors();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}`);
}

void bootstrap();

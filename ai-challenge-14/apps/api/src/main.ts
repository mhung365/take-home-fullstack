import 'reflect-metadata';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { formatIssue, type LoadedConfig } from '@claims/engine';
import { AppModule } from './app.module';
import { configPaths, loadConfigFiles } from './config/load-config';

const logger = new Logger('Bootstrap');

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
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.enableCors();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}`);
}

void bootstrap();

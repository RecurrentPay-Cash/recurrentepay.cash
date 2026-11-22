import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

/**
 * Bootstrap the txserver HTTP app.
 *
 * CORS is enabled from the `CORS_ORIGINS` allow-list so the browser (the web app
 * at `NEXT_PUBLIC_TXSERVER_URL`) may call the txserver directly. Auth is bearer
 * token, so `credentials` stays `false` — a wildcard/credentialed CORS policy
 * would be both unnecessary and unsafe.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: config.corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  await app.listen(config.port);
}

void bootstrap();

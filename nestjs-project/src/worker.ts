import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint of the video worker container.
 *
 * `createApplicationContext` starts the providers without an HTTP listener —
 * the worker is a queue consumer, not a server.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Lets BullMQ finish an in-flight job on SIGTERM instead of leaving a video
  // stuck in `processing` until the stall detector notices.
  app.enableShutdownHooks();

  Logger.log('Video worker started', 'Worker');
}

void bootstrap();

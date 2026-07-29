import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE_NAME } from '../videos/videos.constants';

/**
 * Registers the BullMQ connection and the video processing queue
 * (`phase-03-videos/TD-01`).
 *
 * Imported by both the API graph (which produces jobs) and the worker graph
 * (which consumes them). The `@Processor` itself is registered **only** in the
 * worker graph — see `WorkerModule` — so the API never consumes, which is the
 * process separation `TD-04` decides.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.redisHost,
          port: config.redisPort,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE_NAME }),
  ],
  exports: [BullModule],
})
export class QueueModule {}

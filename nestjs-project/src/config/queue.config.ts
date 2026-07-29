import { registerAs } from '@nestjs/config';

/**
 * Background queue configuration (`phase-03-videos/TD-01`, `TD-09`).
 *
 * The stalled-job settings are not BullMQ defaults: `TD-06` makes jobs
 * long-lived by design (probing a 10GB object over HTTP), so a short stall
 * window would re-queue jobs that are still running.
 */
export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST ?? 'redis',
  redisPort: Number(process.env.REDIS_PORT ?? 6379),

  videoQueueName: process.env.VIDEO_QUEUE_NAME ?? 'video-processing',

  /** Retry policy — TD-09. */
  videoJobAttempts: Number(process.env.VIDEO_JOB_ATTEMPTS ?? 3),
  videoJobBackoffMs: Number(process.env.VIDEO_JOB_BACKOFF_MS ?? 5000),

  /** Worker runtime — TD-04 and the TD-09 stalled-job revision. */
  videoWorkerConcurrency: Number(process.env.VIDEO_WORKER_CONCURRENCY ?? 2),
  videoStalledIntervalMs: Number(
    process.env.VIDEO_STALLED_INTERVAL_MS ?? 60000,
  ),
  videoMaxStalledCount: Number(process.env.VIDEO_MAX_STALLED_COUNT ?? 2),
}));

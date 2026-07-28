/**
 * Name of the BullMQ queue carrying video processing jobs.
 *
 * Read from the environment at module-load time rather than through
 * `ConfigService`: `@Processor(name)` and `@InjectQueue(name)` resolve their DI
 * token when the decorator evaluates, which happens before `ConfigModule`
 * runs. Compose passes `.env` to the containers via `env_file`, so the value
 * is present in `process.env` before any application code executes.
 */
export const VIDEO_QUEUE_NAME =
  process.env.VIDEO_QUEUE_NAME ?? 'video-processing';

/** Name of the single job type this phase enqueues. */
export const PROCESS_VIDEO_JOB = 'process-video';

/** Payload of a `process-video` job.
 *
 * Deliberately minimal: the worker re-reads the row, so a job that waits in
 * the queue can never act on metadata that has since changed.
 */
export interface ProcessVideoJobData {
  videoId: string;
}

/**
 * Container types accepted at upload initiation. Anything outside this set is
 * rejected before a multipart upload is opened.
 */
export const SUPPORTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
] as const;

export type SupportedVideoMimeType = (typeof SUPPORTED_VIDEO_MIME_TYPES)[number];

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  VIDEO_QUEUE_NAME,
  type ProcessVideoJobData,
} from '../videos.constants';
import { VideoProcessingService } from './video-processing.service';

/** `processing_error` is a diagnostic; keep it readable rather than unbounded. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Consumes `process-video` jobs and drives the video to a terminal status
 * (`phase-03-videos/TD-09`).
 *
 * Registered **only** in the worker's module graph. If the API also provided
 * it, both processes would consume jobs and the CPU isolation `TD-04` decides
 * would be lost.
 */
@Processor(VIDEO_QUEUE_NAME, {
  concurrency: Number(process.env.VIDEO_WORKER_CONCURRENCY ?? 2),
  // Not BullMQ defaults: TD-06 makes jobs long-lived by design, so a short
  // stall window would re-queue work that is still running.
  stalledInterval: Number(process.env.VIDEO_STALLED_INTERVAL_MS ?? 60000),
  maxStalledCount: Number(process.env.VIDEO_MAX_STALLED_COUNT ?? 2),
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly videoProcessingService: VideoProcessingService,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      // The video was aborted or deleted while the job waited. Nothing to do,
      // and failing would only burn retries on a row that no longer exists.
      this.logger.warn(`Video ${videoId} no longer exists; skipping job`);
      return;
    }

    if (!video.storage_key) {
      throw new Error(`Video ${videoId} has no storage key to process`);
    }

    const result = await this.videoProcessingService.process(
      video.id,
      video.storage_key,
    );

    await this.videoRepository.update(video.id, {
      status: VideoStatus.READY,
      duration_seconds: result.durationSeconds,
      width: result.width,
      height: result.height,
      video_codec: result.videoCodec,
      audio_codec: result.audioCodec,
      thumbnail_key: result.thumbnailKey,
      processing_error: null,
    });

    this.logger.log(`Video ${videoId} is ready`);
  }

  /**
   * Marks the video failed only once retries are exhausted.
   *
   * A non-final attempt leaves the row in `processing` so a transient fault
   * stays invisible to the user — which is the whole point of retrying.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const attempts = job.opts.attempts ?? this.config.videoJobAttempts;

    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade}/${attempts} failed: ${error.message}`,
      );
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} failed permanently: ${error.message}`,
    );

    await this.videoRepository.update(job.data.videoId, {
      status: VideoStatus.FAILED,
      processing_error: error.message.slice(0, MAX_ERROR_LENGTH),
    });
  }
}

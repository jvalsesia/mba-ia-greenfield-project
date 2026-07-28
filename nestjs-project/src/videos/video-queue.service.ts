import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_QUEUE_NAME,
  type ProcessVideoJobData,
} from './videos.constants';

/**
 * Producer side of the video processing queue.
 *
 * Kept separate from `VideosService` so the domain service depends on an
 * enqueue intent rather than on BullMQ's API.
 */
@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_QUEUE_NAME)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * Enqueues processing for a video that has finished uploading.
   *
   * Retry policy comes from `TD-09`: three attempts with exponential backoff
   * absorb transient faults (a storage blip, a worker restart) without any
   * user-visible state change, while a genuinely undecodable file still
   * reaches a terminal `failed`. Failed jobs are retained for inspection.
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        attempts: this.config.videoJobAttempts,
        backoff: {
          type: 'exponential',
          delay: this.config.videoJobBackoffMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: false,
      },
    );
  }
}

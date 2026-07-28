import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VideoQueueService } from './video-queue.service';
import { PROCESS_VIDEO_JOB, type ProcessVideoJobData } from './videos.constants';

describe('VideoQueueService', () => {
  const config = {
    videoJobAttempts: 3,
    videoJobBackoffMs: 5000,
  } as ConfigType<typeof queueConfig>;

  function makeQueue(): { add: jest.Mock } {
    return { add: jest.fn().mockResolvedValue(undefined) };
  }

  it('enqueues a process-video job carrying only the video id', async () => {
    const queue = makeQueue();
    const service = new VideoQueueService(
      queue as unknown as Queue<ProcessVideoJobData>,
      config,
    );

    await service.enqueueProcessing('video-1');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload] = queue.add.mock.calls[0] as [
      string,
      ProcessVideoJobData,
      unknown,
    ];
    expect(jobName).toBe(PROCESS_VIDEO_JOB);
    // Only the id: the worker re-reads the row, so a queued job can never act
    // on metadata that changed while it waited.
    expect(payload).toEqual({ videoId: 'video-1' });
  });

  it('applies the retry policy decided in TD-09 rather than BullMQ defaults', async () => {
    const queue = makeQueue();
    const service = new VideoQueueService(
      queue as unknown as Queue<ProcessVideoJobData>,
      config,
    );

    await service.enqueueProcessing('video-1');

    const [, , options] = queue.add.mock.calls[0] as [
      string,
      ProcessVideoJobData,
      {
        attempts: number;
        backoff: { type: string; delay: number };
        removeOnFail: boolean;
      },
    ];
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 5000 });
    // Failed jobs are kept so a terminal failure stays inspectable.
    expect(options.removeOnFail).toBe(false);
  });
});

import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VideoQueueService } from './video-queue.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_QUEUE_NAME,
  type ProcessVideoJobData,
} from './videos.constants';

/**
 * Exercised against the real Redis in Compose (`phase-03-videos/TD-10`).
 * A mocked queue would confirm our call shape but not that BullMQ actually
 * persists the job with the options we passed.
 */
describe('VideoQueueService (integration)', () => {
  let service: VideoQueueService;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideoQueueService],
    }).compile();

    service = module.get(VideoQueueService);
    queue = module.get(getQueueToken(VIDEO_QUEUE_NAME));
  });

  beforeEach(async () => {
    await queue.drain(true);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('persists an enqueued job that the worker side can read back', async () => {
    await service.enqueueProcessing('video-integration-1');

    const waiting = await queue.getWaiting();

    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(waiting[0].data).toEqual({ videoId: 'video-integration-1' });
  });

  it('stores the retry policy on the job itself', async () => {
    await service.enqueueProcessing('video-integration-2');

    const [job] = await queue.getWaiting();

    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });
});

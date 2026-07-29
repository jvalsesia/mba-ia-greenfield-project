import type { ConfigType } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import type queueConfig from '../../config/queue.config';
import { Video, VideoStatus } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../videos.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

const config = {
  videoJobAttempts: 3,
} as ConfigType<typeof queueConfig>;

interface Mocks {
  videoRepository: { findOne: jest.Mock; update: jest.Mock };
  processingService: { process: jest.Mock };
}

function makeMocks(): Mocks {
  return {
    videoRepository: {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
    processingService: {
      process: jest.fn().mockResolvedValue({
        durationSeconds: 120,
        width: 1280,
        height: 720,
        videoCodec: 'h264',
        audioCodec: 'aac',
        thumbnailKey: 'thumbnails/video-1/thumb.jpg',
      }),
    },
  };
}

function makeProcessor(mocks: Mocks): VideoProcessor {
  return new VideoProcessor(
    mocks.videoRepository as unknown as Repository<Video>,
    mocks.processingService as unknown as VideoProcessingService,
    config,
  );
}

function makeJob(attemptsMade = 0): Job<ProcessVideoJobData> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts: 3 },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessor — success path', () => {
  let mocks: Mocks;
  let processor: VideoProcessor;

  beforeEach(() => {
    mocks = makeMocks();
    processor = makeProcessor(mocks);
    mocks.videoRepository.findOne.mockResolvedValue({
      id: 'video-1',
      storage_key: 'videos/video-1/source.mp4',
      status: VideoStatus.PROCESSING,
    } as Video);
  });

  it('persists the extracted metadata and marks the video ready', async () => {
    await processor.process(makeJob());

    expect(mocks.videoRepository.update).toHaveBeenCalledWith('video-1', {
      status: VideoStatus.READY,
      duration_seconds: 120,
      width: 1280,
      height: 720,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: 'thumbnails/video-1/thumb.jpg',
      processing_error: null,
    });
  });

  it('re-reads the row rather than trusting the job payload', async () => {
    await processor.process(makeJob());

    expect(mocks.videoRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'video-1' },
    });
    expect(mocks.processingService.process).toHaveBeenCalledWith(
      'video-1',
      'videos/video-1/source.mp4',
    );
  });

  it('exits quietly when the video was deleted while the job waited', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(null);

    await expect(processor.process(makeJob())).resolves.toBeUndefined();

    // Failing here would burn retries on a row that no longer exists.
    expect(mocks.processingService.process).not.toHaveBeenCalled();
    expect(mocks.videoRepository.update).not.toHaveBeenCalled();
  });

  it('fails a video that somehow has no storage key', async () => {
    mocks.videoRepository.findOne.mockResolvedValue({
      id: 'video-1',
      storage_key: null,
    } as Video);

    await expect(processor.process(makeJob())).rejects.toThrow(
      'has no storage key',
    );
  });
});

describe('VideoProcessor — failure handling (TD-09)', () => {
  let mocks: Mocks;
  let processor: VideoProcessor;

  beforeEach(() => {
    mocks = makeMocks();
    processor = makeProcessor(mocks);
  });

  it('leaves the row in processing while retries remain', async () => {
    await processor.onFailed(makeJob(1), new Error('transient blip'));

    // A transient fault must stay invisible to the user — that is the point
    // of retrying at all.
    expect(mocks.videoRepository.update).not.toHaveBeenCalled();
  });

  it('marks the video failed once attempts are exhausted', async () => {
    await processor.onFailed(makeJob(3), new Error('Invalid data found'));

    expect(mocks.videoRepository.update).toHaveBeenCalledWith('video-1', {
      status: VideoStatus.FAILED,
      processing_error: 'Invalid data found',
    });
  });

  it('truncates an unreasonably long diagnostic', async () => {
    await processor.onFailed(makeJob(3), new Error('x'.repeat(5000)));

    const [, patch] = mocks.videoRepository.update.mock.calls[0] as [
      string,
      { processing_error: string },
    ];
    expect(patch.processing_error).toHaveLength(1000);
  });
});

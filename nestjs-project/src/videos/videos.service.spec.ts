import type { ConfigType } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  UploadCompletionFailedException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import type storageConfig from '../config/storage.config';
import type { StorageService } from '../storage/storage.service';
import type { CreateUploadDto } from './dto/create-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import type { VideoQueueService } from './video-queue.service';
import { VideosService } from './videos.service';

const PART_SIZE = 64 * 1024 * 1024; // 64 MiB
const MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GiB

const config = {
  uploadPartSizeBytes: PART_SIZE,
  uploadMaxSizeBytes: MAX_SIZE,
  uploadUrlTtlSeconds: 3600,
} as ConfigType<typeof storageConfig>;

interface Mocks {
  videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findOne: jest.Mock;
  };
  channelsService: { findByUserId: jest.Mock };
  storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    headObjectSize: jest.Mock;
    presignGetForClient: jest.Mock;
    thumbnailPublicUrl: jest.Mock;
    videosBucket: string;
  };
  videoQueueService: { enqueueProcessing: jest.Mock };
}

function makeMocks(): Mocks {
  return {
    videoRepository: {
      create: jest.fn((entity: Partial<Video>) => entity),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    },
    channelsService: { findByUserId: jest.fn() },
    storageService: {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObjectSize: jest.fn().mockResolvedValue('1234'),
      presignGetForClient: jest.fn().mockResolvedValue('https://signed'),
      thumbnailPublicUrl: jest.fn((key: string) => `https://public/${key}`),
      videosBucket: 'streamtube-videos',
    },
    videoQueueService: {
      enqueueProcessing: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function makeService(mocks: Mocks): VideosService {
  return new VideosService(
    mocks.videoRepository as unknown as Repository<Video>,
    mocks.channelsService as unknown as ChannelsService,
    mocks.storageService as unknown as StorageService,
    mocks.videoQueueService as unknown as VideoQueueService,
    config,
  );
}

function makeDto(overrides: Partial<CreateUploadDto> = {}): CreateUploadDto {
  return {
    title: 'My video',
    filename: 'video.mp4',
    mimeType: 'video/mp4',
    sizeBytes: PART_SIZE,
    ...overrides,
  } as CreateUploadDto;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abc12345678',
    channel_id: 'channel-1',
    title: 'My video',
    status: VideoStatus.DRAFT,
    original_filename: 'video.mp4',
    mime_type: 'video/mp4',
    storage_key: 'videos/video-1/source.mp4',
    upload_id: 'upload-1',
    size_bytes: '100',
    thumbnail_key: null,
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: null,
    processing_error: null,
    created_at: new Date('2026-07-28T12:00:00Z'),
    updated_at: new Date('2026-07-28T12:00:00Z'),
    ...overrides,
  } as Video;
}

function uniqueViolationOn(column: string): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
}

describe('VideosService — initiateUpload', () => {
  let mocks: Mocks;
  let service: VideosService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
    mocks.channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    mocks.videoRepository.save.mockImplementation((entity: Partial<Video>) =>
      Promise.resolve(makeVideo(entity)),
    );
  });

  it('rejects a size above the configured maximum before touching storage', async () => {
    await expect(
      service.initiateUpload('user-1', makeDto({ sizeBytes: MAX_SIZE + 1 })),
    ).rejects.toThrow(VideoTooLargeException);

    expect(mocks.storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('accepts a size exactly at the maximum', async () => {
    await expect(
      service.initiateUpload('user-1', makeDto({ sizeBytes: MAX_SIZE })),
    ).resolves.toBeDefined();
  });

  it('rejects an unsupported mime type', async () => {
    await expect(
      service.initiateUpload(
        'user-1',
        makeDto({ mimeType: 'video/avi' as never }),
      ),
    ).rejects.toThrow(UnsupportedVideoTypeException);
  });

  it('throws when the user has no channel', async () => {
    mocks.channelsService.findByUserId.mockResolvedValue(null);

    await expect(service.initiateUpload('user-1', makeDto())).rejects.toThrow(
      ChannelNotFoundException,
    );
  });

  it('derives one part per whole part-size, rounding the final partial part up', async () => {
    await service.initiateUpload(
      'user-1',
      makeDto({ sizeBytes: PART_SIZE * 2 + 1 }),
    );

    expect(mocks.storageService.presignUploadParts).toHaveBeenCalledWith(
      expect.any(String),
      'upload-1',
      3,
    );
  });

  it('splits a 10 GiB upload into 160 parts, far under S3 10,000-part cap', async () => {
    await service.initiateUpload('user-1', makeDto({ sizeBytes: MAX_SIZE }));

    const [, , partCount] = mocks.storageService.presignUploadParts.mock
      .calls[0] as [string, string, number];
    expect(partCount).toBe(160);
    expect(partCount).toBeLessThan(10_000);
  });

  it('always presigns at least one part, even for a 1-byte file', async () => {
    await service.initiateUpload('user-1', makeDto({ sizeBytes: 1 }));

    expect(mocks.storageService.presignUploadParts).toHaveBeenCalledWith(
      expect.any(String),
      'upload-1',
      1,
    );
  });

  it('persists the storage key and upload id on the draft row', async () => {
    await service.initiateUpload('user-1', makeDto());

    expect(mocks.videoRepository.update).toHaveBeenCalledWith('video-1', {
      storage_key: 'videos/video-1/source.mp4',
      upload_id: 'upload-1',
    });
  });

  it('retries with a fresh public_id when the unique index rejects one', async () => {
    mocks.videoRepository.save
      .mockRejectedValueOnce(uniqueViolationOn('public_id'))
      .mockImplementationOnce((entity: Partial<Video>) =>
        Promise.resolve(makeVideo(entity)),
      );

    await expect(
      service.initiateUpload('user-1', makeDto()),
    ).resolves.toBeDefined();
    expect(mocks.videoRepository.save).toHaveBeenCalledTimes(2);
  });

  it('propagates a unique violation on any other column instead of retrying', async () => {
    mocks.videoRepository.save.mockRejectedValue(
      uniqueViolationOn('channel_id'),
    );

    await expect(service.initiateUpload('user-1', makeDto())).rejects.toThrow(
      QueryFailedError,
    );
    expect(mocks.videoRepository.save).toHaveBeenCalledTimes(1);
  });
});

describe('VideosService — completeUpload', () => {
  let mocks: Mocks;
  let service: VideosService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
    mocks.channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    mocks.videoRepository.findOne.mockResolvedValue(makeVideo());
  });

  const parts = { parts: [{ partNumber: 1, etag: 'e1' }] };

  it('moves the video to processing and enqueues exactly one job', async () => {
    const result = await service.completeUpload('user-1', 'video-1', parts);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(mocks.videoRepository.update).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      }),
    );
    expect(mocks.videoQueueService.enqueueProcessing).toHaveBeenCalledTimes(1);
    expect(mocks.videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
      'video-1',
    );
  });

  it('records the size reported by storage, not the size the client declared', async () => {
    mocks.storageService.headObjectSize.mockResolvedValue('987654321');

    await service.completeUpload('user-1', 'video-1', parts);

    expect(mocks.videoRepository.update).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({ size_bytes: '987654321' }),
    );
  });

  it('writes the status before enqueuing, so the worker never reads a draft', async () => {
    const order: string[] = [];
    mocks.videoRepository.update.mockImplementation(() => {
      order.push('update');
      return Promise.resolve(undefined);
    });
    mocks.videoQueueService.enqueueProcessing.mockImplementation(() => {
      order.push('enqueue');
      return Promise.resolve(undefined);
    });

    await service.completeUpload('user-1', 'video-1', parts);

    expect(order).toEqual(['update', 'enqueue']);
  });

  it('rejects a video that has already left draft', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      service.completeUpload('user-1', 'video-1', parts),
    ).rejects.toThrow(VideoNotInDraftException);
    expect(mocks.videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
  });

  it("reports another channel's video as not found, never as forbidden", async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ channel_id: 'someone-else' }),
    );

    await expect(
      service.completeUpload('user-1', 'video-1', parts),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('maps a storage rejection of the part list to UPLOAD_COMPLETION_FAILED', async () => {
    mocks.storageService.completeMultipartUpload.mockRejectedValue(
      new Error('InvalidPart'),
    );

    await expect(
      service.completeUpload('user-1', 'video-1', parts),
    ).rejects.toThrow(UploadCompletionFailedException);
    expect(mocks.videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
  });
});

describe('VideosService — abortUpload', () => {
  let mocks: Mocks;
  let service: VideosService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
    mocks.channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    mocks.videoRepository.findOne.mockResolvedValue(makeVideo());
  });

  it('aborts the multipart upload and deletes the draft row', async () => {
    await service.abortUpload('user-1', 'video-1');

    expect(mocks.storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/source.mp4',
      'upload-1',
    );
    expect(mocks.videoRepository.delete).toHaveBeenCalledWith('video-1');
  });

  it('refuses to abort a video that already completed', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.READY }),
    );

    await expect(service.abortUpload('user-1', 'video-1')).rejects.toThrow(
      VideoNotInDraftException,
    );
    expect(mocks.videoRepository.delete).not.toHaveBeenCalled();
  });

  it("reports another channel's video as not found", async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ channel_id: 'someone-else' }),
    );

    await expect(service.abortUpload('user-1', 'video-1')).rejects.toThrow(
      VideoNotFoundException,
    );
  });
});

describe('VideosService — delivery authorization (TD-11)', () => {
  let mocks: Mocks;
  let service: VideosService;

  const channel = { id: 'channel-1', nickname: 'owner' };

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  it('serves a ready video to an anonymous viewer', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.READY, channel } as Partial<Video>),
    );

    await expect(service.findByPublicId('abc12345678')).resolves.toBeDefined();
  });

  it('hides a non-ready video from a stranger as 404, not 403', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING, channel } as Partial<Video>),
    );
    mocks.channelsService.findByUserId.mockResolvedValue({ id: 'other' });

    await expect(
      service.findByPublicId('abc12345678', 'stranger'),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('shows a non-ready video to the channel that owns it', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING, channel } as Partial<Video>),
    );
    mocks.channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    const video = await service.findByPublicId('abc12345678', 'owner-user');
    expect(video.status).toBe(VideoStatus.PROCESSING);
  });

  it('tells the owner their own video is not ready rather than 404', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING, channel } as Partial<Video>),
    );
    mocks.channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    await expect(
      service.getStreamUrl('abc12345678', 'owner-user'),
    ).rejects.toThrow(VideoNotReadyException);
  });

  it('bakes an attachment disposition with the original filename into the download URL', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({
        status: VideoStatus.READY,
        original_filename: 'holiday.mp4',
        channel,
      } as Partial<Video>),
    );

    await service.getDownloadUrl('abc12345678');

    expect(mocks.storageService.presignGetForClient).toHaveBeenCalledWith(
      'streamtube-videos',
      'videos/video-1/source.mp4',
      { responseContentDisposition: 'attachment; filename="holiday.mp4"' },
    );
  });

  it('exposes the thumbnail as a direct public URL, not a signed one', async () => {
    mocks.videoRepository.findOne.mockResolvedValue(
      makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: 'thumbnails/video-1/thumb.jpg',
        channel,
      } as Partial<Video>),
    );

    const response = await service.getVideoResponse('abc12345678');

    expect(response.thumbnailUrl).toBe(
      'https://public/thumbnails/video-1/thumb.jpg',
    );
  });
});

import type { StorageService } from '../../storage/storage.service';
import type { FfmpegRunner, FfmpegResult } from './ffmpeg-runner';
import { VideoProcessingService } from './video-processing.service';

const PROBE_OUTPUT = JSON.stringify({
  format: { duration: '100.0' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});

interface Mocks {
  storageService: {
    presignGetForWorker: jest.Mock;
    putThumbnail: jest.Mock;
    videosBucket: string;
  };
  ffmpegRunner: { run: jest.Mock };
}

function makeMocks(): Mocks {
  return {
    storageService: {
      presignGetForWorker: jest.fn().mockResolvedValue('https://signed/source'),
      putThumbnail: jest.fn().mockResolvedValue(undefined),
      videosBucket: 'streamtube-videos',
    },
    ffmpegRunner: {
      run: jest.fn((command: string): Promise<FfmpegResult> => {
        if (command === 'ffprobe') {
          return Promise.resolve({ stdout: PROBE_OUTPUT, stderr: '' });
        }
        // The ffmpeg call writes the JPEG to the path in its args; the service
        // reads it back, so the stub must leave a real file behind.
        return Promise.resolve({ stdout: '', stderr: '' });
      }),
    },
  };
}

function makeService(mocks: Mocks): VideoProcessingService {
  return new VideoProcessingService(
    mocks.storageService as unknown as StorageService,
    mocks.ffmpegRunner as unknown as FfmpegRunner,
  );
}

/** Makes the ffmpeg stub actually create the output file it was asked for. */
function writeThumbnailOnFfmpeg(mocks: Mocks): void {
  const { writeFileSync } =
    jest.requireActual<typeof import('node:fs')>('node:fs');
  mocks.ffmpegRunner.run.mockImplementation(
    (command: string, args: string[]): Promise<FfmpegResult> => {
      if (command === 'ffprobe') {
        return Promise.resolve({ stdout: PROBE_OUTPUT, stderr: '' });
      }
      writeFileSync(args[args.length - 1], 'jpeg-bytes');
      return Promise.resolve({ stdout: '', stderr: '' });
    },
  );
}

describe('VideoProcessingService', () => {
  let mocks: Mocks;
  let service: VideoProcessingService;

  beforeEach(() => {
    mocks = makeMocks();
    writeThumbnailOnFfmpeg(mocks);
    service = makeService(mocks);
  });

  it('feeds ffprobe a presigned URL rather than a local path', async () => {
    await service.process('video-1', 'videos/video-1/source.mp4');

    const [command, args] = mocks.ffmpegRunner.run.mock.calls[0] as [
      string,
      string[],
    ];
    expect(command).toBe('ffprobe');
    expect(args).toContain('https://signed/source');
    expect(args).toEqual(
      expect.arrayContaining(['-print_format', 'json', '-show_streams']),
    );
  });

  it('places -ss before -i so ffmpeg seeks instead of decoding from the start', async () => {
    await service.process('video-1', 'videos/video-1/source.mp4');

    const [, args] = mocks.ffmpegRunner.run.mock.calls[1] as [string, string[]];
    // Input seeking is what keeps this fast on a 10GB file read over HTTP.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('10.000');
  });

  it('returns the parsed metadata alongside the thumbnail key', async () => {
    const result = await service.process(
      'video-1',
      'videos/video-1/source.mp4',
    );

    expect(result).toEqual({
      durationSeconds: 100,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
      thumbnailKey: 'thumbnails/video-1/thumb.jpg',
    });
  });

  it('uploads the generated frame to the thumbnails bucket', async () => {
    await service.process('video-1', 'videos/video-1/source.mp4');

    expect(mocks.storageService.putThumbnail).toHaveBeenCalledWith(
      'thumbnails/video-1/thumb.jpg',
      expect.any(Buffer),
    );
  });

  it('removes the temporary file even when the upload fails', async () => {
    const { existsSync } =
      jest.requireActual<typeof import('node:fs')>('node:fs');
    let tempPath = '';
    mocks.ffmpegRunner.run.mockImplementation(
      (command: string, args: string[]): Promise<FfmpegResult> => {
        if (command === 'ffprobe') {
          return Promise.resolve({ stdout: PROBE_OUTPUT, stderr: '' });
        }
        tempPath = args[args.length - 1];
        jest
          .requireActual<typeof import('node:fs')>('node:fs')
          .writeFileSync(tempPath, 'jpeg-bytes');
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );
    mocks.storageService.putThumbnail.mockRejectedValue(new Error('boom'));

    await expect(
      service.process('video-1', 'videos/video-1/source.mp4'),
    ).rejects.toThrow('boom');

    // A worker that leaks a temp file per failed job slowly fills its disk.
    expect(existsSync(tempPath)).toBe(false);
  });

  it('propagates the probe failure without attempting a thumbnail', async () => {
    mocks.ffmpegRunner.run.mockRejectedValue(
      new Error('ffprobe exited with code 1: Invalid data found'),
    );

    await expect(
      service.process('video-1', 'videos/video-1/source.mp4'),
    ).rejects.toThrow('Invalid data found');
    expect(mocks.storageService.putThumbnail).not.toHaveBeenCalled();
  });
});

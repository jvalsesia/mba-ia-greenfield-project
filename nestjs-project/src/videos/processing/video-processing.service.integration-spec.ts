import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { FfmpegRunner } from './ffmpeg-runner';
import { VideoProcessingService } from './video-processing.service';

/**
 * Exercised against real FFmpeg and real MinIO (`phase-03-videos/TD-10`).
 *
 * The fixture is synthesised at test time with `ffmpeg -f lavfi` rather than
 * committed, so the repository carries no binary assets.
 */
describe('VideoProcessingService (integration)', () => {
  let storageService: StorageService;
  let processingService: VideoProcessingService;
  let ffmpegRunner: FfmpegRunner;
  const tempFiles: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [VideoProcessingService, FfmpegRunner],
    }).compile();

    storageService = module.get(StorageService);
    processingService = module.get(VideoProcessingService);
    ffmpegRunner = module.get(FfmpegRunner);

    await storageService.ensureBuckets();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(tempFiles.map((file) => rm(file, { force: true })));
  });

  /** Synthesises a clip with both a video and an audio stream. */
  async function makeFixture(
    seconds: number,
    size = '320x240',
  ): Promise<string> {
    const path = join(tmpdir(), `fixture-${randomUUID()}.mp4`);
    tempFiles.push(path);

    await ffmpegRunner.run('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${seconds}:size=${size}:rate=15`,
      '-f',
      'lavfi',
      '-i',
      `sine=duration=${seconds}`,
      '-shortest',
      // Puts the moov atom up front so probing over HTTP does not need to
      // fetch the tail first.
      '-movflags',
      '+faststart',
      '-y',
      path,
    ]);

    return path;
  }

  /** Uploads a local file to the videos bucket through the real handshake. */
  async function uploadToStorage(
    localPath: string,
    videoId: string,
  ): Promise<string> {
    const key = `videos/${videoId}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const [part] = await storageService.presignUploadParts(key, uploadId, 1);

    const body = await readFile(localPath);
    const res = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`Fixture upload failed: ${res.status}`);

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: res.headers.get('etag')! },
    ]);

    return key;
  }

  it('extracts duration, dimensions and codecs from a real file over HTTP', async () => {
    const videoId = randomUUID();
    const key = await uploadToStorage(await makeFixture(4, '640x360'), videoId);

    const result = await processingService.process(videoId, key);

    expect(result.durationSeconds).toBe(4);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
  }, 120_000);

  it('stores a real JPEG thumbnail in the public thumbnails bucket', async () => {
    const videoId = randomUUID();
    const key = await uploadToStorage(await makeFixture(4), videoId);

    const result = await processingService.process(videoId, key);

    expect(result.thumbnailKey).toBe(`thumbnails/${videoId}/thumb.jpg`);

    const res = await fetch(
      storageService.thumbnailPublicUrl(result.thumbnailKey),
    );
    expect(res.status).toBe(200);

    const bytes = Buffer.from(await res.arrayBuffer());
    // JPEG magic number — proves an actual image was produced, not an empty
    // file or an FFmpeg error page.
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(bytes.length).toBeGreaterThan(1000);
  }, 120_000);

  it('handles a video with no audio stream', async () => {
    const videoId = randomUUID();
    const path = join(tmpdir(), `fixture-${randomUUID()}.mp4`);
    tempFiles.push(path);
    await ffmpegRunner.run('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x240:rate=15',
      '-movflags',
      '+faststart',
      '-y',
      path,
    ]);
    const key = await uploadToStorage(path, videoId);

    const result = await processingService.process(videoId, key);

    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBeNull();
  }, 120_000);

  it('fails with FFmpeg own diagnostic when the object is not a video', async () => {
    const videoId = randomUUID();
    const key = `videos/${videoId}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const [part] = await storageService.presignUploadParts(key, uploadId, 1);
    const res = await fetch(part.url, {
      method: 'PUT',
      body: 'this is definitely not a video file',
    });
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: res.headers.get('etag')! },
    ]);

    // The message must carry ffprobe's own words — a generic wrapper error
    // would tell the user nothing about why their file was rejected.
    await expect(processingService.process(videoId, key)).rejects.toThrow(
      /ffprobe exited with code/,
    );
  }, 120_000);
});

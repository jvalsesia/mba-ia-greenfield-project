import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageModule } from '../src/storage/storage.module';
import { StorageService } from '../src/storage/storage.service';
import { bodyOf, type ApiErrorBody } from '../src/test/api-response';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { FfmpegRunner } from '../src/videos/processing/ffmpeg-runner';
import { VideoProcessingService } from '../src/videos/processing/video-processing.service';

interface CreateUploadBody {
  videoId: string;
  publicId: string;
  uploadId: string;
  partSizeBytes: number;
  parts: { partNumber: number; url: string }[];
  expiresIn: number;
}

interface VideoBody {
  publicId: string;
  title: string;
  status: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  sizeBytes: string | null;
  channel: { id: string; nickname: string };
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let ffmpegRunner: FfmpegRunner;
  let processingService: VideoProcessingService;
  let throttlerStorage: ThrottlerStorageService;

  const tempFiles: string[] = [];
  let userCounter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      // StorageModule is imported explicitly so the two providers below can
      // resolve StorageService at this scope — AppModule keeps it internal.
      imports: [AppModule, StorageModule],
      // The worker container owns the real processor; most assertions drive
      // processing directly so they do not depend on another container's
      // scheduling. One test deliberately waits on the worker instead.
      providers: [VideoProcessingService, FfmpegRunner],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    ffmpegRunner = moduleFixture.get(FfmpegRunner);
    processingService = moduleFixture.get(VideoProcessingService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    await storageService.ensureBuckets();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(tempFiles.map((file) => rm(file, { force: true })));
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // Every test registers a user, and /auth/register is rate limited. Without
    // this the later tests in the file 429 instead of exercising videos.
    throttlerStorage.storage.clear();
  });

  // --- helpers -------------------------------------------------------------

  async function registerAndLogin(): Promise<{
    token: string;
    email: string;
  }> {
    userCounter += 1;
    const email = `video_e2e_${userCounter}_${Date.now()}@example.com`;
    const password = 'password123';

    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return {
      token: bodyOf<{ access_token: string }>(login).access_token,
      email,
    };
  }

  async function makeFixture(seconds = 3): Promise<Buffer> {
    const path = join(tmpdir(), `e2e-${randomUUID()}.mp4`);
    tempFiles.push(path);

    await ffmpegRunner.run('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${seconds}:size=320x240:rate=15`,
      '-f',
      'lavfi',
      '-i',
      `sine=duration=${seconds}`,
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      path,
    ]);

    return readFile(path);
  }

  /** Runs the whole handshake and returns the video, still `processing`. */
  async function uploadVideo(
    token: string,
    title = 'My holiday video',
  ): Promise<{ upload: CreateUploadBody; fixture: Buffer }> {
    const fixture = await makeFixture();

    const created = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title,
        filename: 'holiday.mp4',
        mimeType: 'video/mp4',
        sizeBytes: fixture.length,
      })
      .expect(201);

    const upload = bodyOf<CreateUploadBody>(created);

    // The client PUTs directly to storage — these bytes never touch the API.
    const res = await fetch(upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(fixture),
    });
    expect(res.status).toBe(200);

    await request(app.getHttpServer())
      .post(`/videos/${upload.videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parts: [{ partNumber: 1, etag: res.headers.get('etag')! }],
      })
      .expect(200);

    return { upload, fixture };
  }

  /** Drives processing the way the worker container would. */
  async function processVideo(videoId: string): Promise<void> {
    const video = await videoRepository.findOneByOrFail({ id: videoId });
    const result = await processingService.process(
      video.id,
      video.storage_key!,
    );
    await videoRepository.update(video.id, {
      status: VideoStatus.READY,
      duration_seconds: result.durationSeconds,
      width: result.width,
      height: result.height,
      video_codec: result.videoCodec,
      audio_codec: result.audioCodec,
      thumbnail_key: result.thumbnailKey,
    });
  }

  // --- upload initiation ---------------------------------------------------

  describe('POST /videos/uploads', () => {
    it('pre-registers the video as a draft and returns presigned part targets', async () => {
      const { token } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Draft video',
          filename: 'draft.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(201);

      const body = bodyOf<CreateUploadBody>(res);
      expect(body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(body.uploadId).toBeTruthy();
      expect(body.parts).toHaveLength(1);
      expect(body.parts[0].url).toContain('X-Amz-Signature');

      const stored = await videoRepository.findOneByOrFail({
        id: body.videoId,
      });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.upload_id).toBe(body.uploadId);
    }, 60_000);

    it('splits a 10 GiB declared upload into 160 parts', async () => {
      const { token } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Huge video',
          filename: 'huge.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 10 * 1024 * 1024 * 1024,
        })
        .expect(201);

      expect(bodyOf<CreateUploadBody>(res).parts).toHaveLength(160);
    }, 60_000);

    it('rejects a size above the 10 GiB ceiling', async () => {
      const { token } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Too big',
          filename: 'big.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
        })
        .expect(400);

      expect(bodyOf<ApiErrorBody>(res).error).toBe('VIDEO_TOO_LARGE');
    }, 60_000);

    it('rejects an unsupported container type', async () => {
      const { token } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Wrong type',
          filename: 'clip.avi',
          mimeType: 'video/avi',
          sizeBytes: 1024,
        })
        .expect(400);

      expect(bodyOf<ApiErrorBody>(res).error).toBe('VALIDATION_ERROR');
    }, 60_000);

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({
          title: 'Anonymous',
          filename: 'a.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(401);
    });
  });

  // --- completion and abort ------------------------------------------------

  describe('POST /videos/:id/uploads/complete', () => {
    it('moves the video to processing', async () => {
      const { token } = await registerAndLogin();
      const { upload } = await uploadVideo(token);

      const stored = await videoRepository.findOneByOrFail({
        id: upload.videoId,
      });
      expect(stored.status).toBe(VideoStatus.PROCESSING);
      expect(stored.upload_id).toBeNull();
    }, 120_000);

    it('rejects a second completion of the same upload', async () => {
      const { token } = await registerAndLogin();
      const { upload } = await uploadVideo(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${upload.videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag: '"x"' }] })
        .expect(409);

      expect(bodyOf<ApiErrorBody>(res).error).toBe('VIDEO_NOT_IN_DRAFT');
    }, 120_000);

    it("reports another user's video as not found, not forbidden", async () => {
      const owner = await registerAndLogin();
      const stranger = await registerAndLogin();

      const created = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          title: 'Private draft',
          filename: 'p.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(
          `/videos/${bodyOf<CreateUploadBody>(created).videoId}/uploads/complete`,
        )
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ parts: [{ partNumber: 1, etag: '"x"' }] })
        .expect(404);

      expect(bodyOf<ApiErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    }, 60_000);
  });

  describe('DELETE /videos/:id/upload', () => {
    it('removes the draft row and releases the multipart upload', async () => {
      const { token } = await registerAndLogin();

      const created = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Abandoned',
          filename: 'abandoned.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(201);

      const { videoId } = bodyOf<CreateUploadBody>(created);

      await request(app.getHttpServer())
        .delete(`/videos/${videoId}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(await videoRepository.findOneBy({ id: videoId })).toBeNull();
    }, 60_000);
  });

  // --- processing, delivery and unique URLs --------------------------------

  describe('processing and delivery', () => {
    it('extracts metadata and a thumbnail, then serves the video publicly', async () => {
      const { token } = await registerAndLogin();
      const { upload } = await uploadVideo(token);

      await processVideo(upload.videoId);

      // Anonymous: no Authorization header at all.
      const res = await request(app.getHttpServer())
        .get(`/videos/${upload.publicId}`)
        .expect(200);

      const body = bodyOf<VideoBody>(res);
      expect(body.status).toBe(VideoStatus.READY);
      expect(body.durationSeconds).toBe(3);
      expect(body.width).toBe(320);
      expect(body.height).toBe(240);
      expect(body.thumbnailUrl).toContain('thumb.jpg');
      expect(body.channel.nickname).toBeTruthy();

      const thumbRes = await fetch(body.thumbnailUrl!);
      expect(thumbRes.status).toBe(200);
    }, 180_000);

    it('streams via a redirect whose target answers Range with 206', async () => {
      const { token } = await registerAndLogin();
      const { upload, fixture } = await uploadVideo(token);
      await processVideo(upload.videoId);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${upload.publicId}/stream`)
        .expect(302);

      const location = redirect.headers.location;
      expect(location).toContain('X-Amz-Signature');

      const ranged = await fetch(location, {
        headers: { Range: 'bytes=0-1023' },
      });

      // The whole point: playback fetches a window, never the whole file.
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${fixture.length}`,
      );
    }, 180_000);

    it('downloads with an attachment disposition and the original filename', async () => {
      const { token } = await registerAndLogin();
      const { upload } = await uploadVideo(token);
      await processVideo(upload.videoId);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${upload.publicId}/download`)
        .expect(302);

      const res = await fetch(redirect.headers.location);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="holiday.mp4"',
      );
    }, 180_000);

    it('gives every video a distinct public URL', async () => {
      const { token } = await registerAndLogin();

      const publicIds = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const created = await request(app.getHttpServer())
          .post('/videos/uploads')
          .set('Authorization', `Bearer ${token}`)
          .send({
            title: `Video ${i}`,
            filename: `v${i}.mp4`,
            mimeType: 'video/mp4',
            sizeBytes: 1024,
          })
          .expect(201);
        publicIds.add(bodyOf<CreateUploadBody>(created).publicId);
      }

      expect(publicIds.size).toBe(5);
    }, 120_000);

    it('hides an unprocessed video from strangers but shows it to its owner', async () => {
      const owner = await registerAndLogin();
      const { upload } = await uploadVideo(owner.token);

      await request(app.getHttpServer())
        .get(`/videos/${upload.publicId}`)
        .expect(404);

      const ownerView = await request(app.getHttpServer())
        .get(`/videos/${upload.publicId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(bodyOf<VideoBody>(ownerView).status).toBe(VideoStatus.PROCESSING);
    }, 120_000);

    it('tells the owner their unprocessed video is not ready rather than 404', async () => {
      const owner = await registerAndLogin();
      const { upload } = await uploadVideo(owner.token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${upload.publicId}/stream`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);

      expect(bodyOf<ApiErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    }, 120_000);

    it('returns 404 for an unknown public id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/doesnotexis')
        .expect(404);

      expect(bodyOf<ApiErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  // --- the worker container ------------------------------------------------

  describe('background worker', () => {
    it('processes an enqueued upload automatically, with no manual step', async () => {
      const { token } = await registerAndLogin();
      const { upload } = await uploadVideo(token);

      // Nothing below drives processing: the job was enqueued by the
      // completion call and is picked up by the video-worker container.
      const deadline = Date.now() + 90_000;
      let video = await videoRepository.findOneByOrFail({
        id: upload.videoId,
      });

      while (video.status === VideoStatus.PROCESSING && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        video = await videoRepository.findOneByOrFail({ id: upload.videoId });
      }

      expect(video.status).toBe(VideoStatus.READY);
      expect(video.duration_seconds).toBe(3);
      expect(video.thumbnail_key).toBe(`thumbnails/${video.id}/thumb.jpg`);
      expect(video.processing_error).toBeNull();
    }, 180_000);
  });
});

import { randomUUID } from 'node:crypto';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './s3-client.provider';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Exercised against the real MinIO in Compose (`phase-03-videos/TD-10`).
 *
 * The contracts under test — presigned signatures, multipart ETags, Range
 * responses, bucket policy enforcement — are defined by the storage service,
 * not by our code. A mock would only confirm our assumptions about them.
 */
describe('StorageService (integration)', () => {
  let storageService: StorageService;
  let internalClient: S3Client;

  // 5 MiB is S3's minimum part size for any part but the last, so a two-part
  // upload is the smallest one that genuinely exercises multipart assembly.
  const PART_SIZE = 5 * 1024 * 1024;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    internalClient = module.get(S3_INTERNAL_CLIENT);

    await storageService.ensureBuckets();
  });

  afterAll(() => {
    internalClient.destroy();
  });

  describe('ensureBuckets', () => {
    it('is idempotent across repeated calls', async () => {
      await expect(storageService.ensureBuckets()).resolves.not.toThrow();
      await expect(storageService.ensureBuckets()).resolves.not.toThrow();
    });
  });

  describe('multipart upload round-trip', () => {
    it('assembles parts into an object whose bytes match the source', async () => {
      const key = `videos/${randomUUID()}/source.mp4`;
      const partA = Buffer.alloc(PART_SIZE, 0x41);
      const partB = Buffer.from('tail-bytes');

      const uploadId = await storageService.createMultipartUpload(
        key,
        'video/mp4',
      );
      const presigned = await storageService.presignUploadParts(
        key,
        uploadId,
        2,
      );

      expect(presigned).toHaveLength(2);
      expect(presigned[0].partNumber).toBe(1);

      const etags: { partNumber: number; etag: string }[] = [];
      for (const [index, body] of [partA, partB].entries()) {
        const res = await fetch(presigned[index].url, {
          method: 'PUT',
          body: new Uint8Array(body),
        });
        expect(res.status).toBe(200);
        const etag = res.headers.get('etag');
        expect(etag).toBeTruthy();
        etags.push({ partNumber: index + 1, etag: etag! });
      }

      // Deliberately out of order: the service must sort before completing.
      await storageService.completeMultipartUpload(
        key,
        uploadId,
        [...etags].reverse(),
      );

      const size = await storageService.headObjectSize(
        storageService.videosBucket,
        key,
      );
      expect(size).toBe(String(partA.length + partB.length));

      const url = await storageService.presignGetForWorker(
        storageService.videosBucket,
        key,
      );
      const downloaded = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect(downloaded.equals(Buffer.concat([partA, partB]))).toBe(true);
    });
  });

  describe('abortMultipartUpload', () => {
    it('removes the upload from the pending list', async () => {
      const key = `videos/${randomUUID()}/source.mp4`;
      const uploadId = await storageService.createMultipartUpload(
        key,
        'video/mp4',
      );

      const before = await internalClient.send(
        new ListMultipartUploadsCommand({
          Bucket: storageService.videosBucket,
          Prefix: key,
        }),
      );
      expect(before.Uploads ?? []).toHaveLength(1);

      await storageService.abortMultipartUpload(key, uploadId);

      const after = await internalClient.send(
        new ListMultipartUploadsCommand({
          Bucket: storageService.videosBucket,
          Prefix: key,
        }),
      );
      expect(after.Uploads ?? []).toHaveLength(0);
    });
  });

  describe('presigned GET delivery', () => {
    let key: string;
    const body = Buffer.from('0123456789abcdefghij');

    beforeAll(async () => {
      key = `videos/${randomUUID()}/source.mp4`;
      const uploadId = await storageService.createMultipartUpload(
        key,
        'video/mp4',
      );
      const [part] = await storageService.presignUploadParts(key, uploadId, 1);
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      await storageService.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: res.headers.get('etag')! },
      ]);
    });

    it('answers a ranged request with 206 and a Content-Range header', async () => {
      const url = await storageService.presignGetForClient(
        storageService.videosBucket,
        key,
      );

      const res = await fetch(url, { headers: { Range: 'bytes=0-4' } });

      // This is the property streaming depends on: a player must be able to
      // fetch a window without downloading the whole object.
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 0-4/${body.length}`);
      expect(await res.text()).toBe('01234');
    });

    it('serves the whole object with 200 when no Range is sent', async () => {
      const url = await storageService.presignGetForClient(
        storageService.videosBucket,
        key,
      );

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body.toString());
    });

    it('applies a content-disposition baked in before signing', async () => {
      const url = await storageService.presignGetForClient(
        storageService.videosBucket,
        key,
        { responseContentDisposition: 'attachment; filename="original.mp4"' },
      );

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="original.mp4"',
      );
    });
  });

  describe('bucket access policy', () => {
    it('serves thumbnails anonymously but keeps videos private', async () => {
      const videoId = randomUUID();
      const thumbKey = `thumbnails/${videoId}/thumb.jpg`;
      await storageService.putThumbnail(thumbKey, Buffer.from('fake-jpeg'));

      const thumbRes = await fetch(storageService.thumbnailPublicUrl(thumbKey));
      expect(thumbRes.status).toBe(200);
      expect(await thumbRes.text()).toBe('fake-jpeg');

      // The same unsigned access against the videos bucket must be refused —
      // that asymmetry is the whole point of the two-bucket layout.
      const videoRes = await fetch(
        `${process.env.S3_PUBLIC_ENDPOINT ?? 'http://minio:9000'}/${
          storageService.videosBucket
        }/videos/${videoId}/source.mp4`,
      );
      expect(videoRes.status).toBeGreaterThanOrEqual(400);
    });
  });
});

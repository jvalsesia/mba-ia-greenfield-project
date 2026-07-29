import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './s3-client.provider';

/** A part of a multipart upload, as the client reports it back. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** A presigned target the client uploads one part to. */
export interface PresignedPart {
  partNumber: number;
  url: string;
}

/** Optional response-header overrides baked into a presigned GET. */
export interface PresignGetOptions {
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /** A cold `docker compose up` should self-provision — no manual `mc` step. */
  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBuckets();
  }

  get videosBucket(): string {
    return this.config.videosBucket;
  }

  get thumbnailsBucket(): string {
    return this.config.thumbnailsBucket;
  }

  /**
   * Creates both buckets if absent and applies the public-read policy to the
   * thumbnails bucket. Idempotent — safe to call on every boot.
   */
  async ensureBuckets(): Promise<void> {
    await this.ensureBucket(this.config.videosBucket);
    await this.ensureBucket(this.config.thumbnailsBucket);
    await this.applyPublicReadPolicy(this.config.thumbnailsBucket);
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch {
      // HeadBucket throws for both "absent" and "no permission". Creating is
      // the only way to tell them apart here, and CreateBucket on an existing
      // bucket is harmless.
    }

    try {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
      this.logger.log(`Created bucket "${bucket}"`);
    } catch (error) {
      // A concurrent boot (API and worker start together) may have won the
      // race. Re-check rather than failing startup.
      await this.internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
      this.logger.warn(
        `Bucket "${bucket}" already existed when creating: ${String(error)}`,
      );
    }
  }

  /**
   * Thumbnails are world-readable by design (`TD-03`): they are small derived
   * images that listing pages render by the dozen, and signing each one would
   * cost a round-trip per tile.
   */
  private async applyPublicReadPolicy(bucket: string): Promise<void> {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
      ],
    };

    await this.internalClient.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify(policy),
      }),
    );
  }

  /** Opens a multipart upload and returns its `UploadId`. */
  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId for the upload');
    }

    return result.UploadId;
  }

  /**
   * Presigns one `PUT` target per part. Signed with the public client, because
   * the client uploading the parts lives outside the Compose network.
   */
  async presignUploadParts(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.publicClient,
        new UploadPartCommand({
          Bucket: this.config.videosBucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.config.uploadUrlTtlSeconds },
      );
      parts.push({ partNumber, url });
    }

    return parts;
  }

  /** Assembles the uploaded parts into the final object. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  /** Releases the parts of an upload the client abandoned or cancelled. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Size in bytes of the stored object, as a string (it can exceed 2^53). */
  async headObjectSize(bucket: string, key: string): Promise<string | null> {
    const result = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );

    return result.ContentLength === undefined
      ? null
      : String(result.ContentLength);
  }

  /** Stores a generated thumbnail in the public thumbnails bucket. */
  async putThumbnail(key: string, body: Buffer): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.thumbnailsBucket,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
      }),
    );
  }

  /**
   * Presigns a GET for an external consumer — playback or download.
   *
   * `responseContentDisposition` is passed to the command *before* signing:
   * appending it to a finished URL would invalidate the signature.
   */
  async presignGetForClient(
    bucket: string,
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: this.config.deliveryUrlTtlSeconds },
    );
  }

  /**
   * Presigns a GET the worker feeds to FFmpeg as an input URL.
   *
   * Signed with the internal client and a longer TTL: the consumer is inside
   * the Compose network, and a probe must not expire mid-job.
   */
  async presignGetForWorker(bucket: string, key: string): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: this.config.workerUrlTtlSeconds },
    );
  }

  /** Direct, unsigned URL of a thumbnail — the point of the public-read policy. */
  thumbnailPublicUrl(key: string): string {
    return `${this.config.publicEndpoint}/${this.config.thumbnailsBucket}/${key}`;
  }
}

import { registerAs } from '@nestjs/config';

/**
 * Object storage configuration (`phase-03-videos/TD-02`, `TD-03`, `TD-06`, `TD-08`).
 *
 * `endpoint` and `publicEndpoint` are deliberately separate. SigV4 signs the
 * `Host` header, so an endpoint cannot be substituted after signing: a URL
 * signed against the internal Compose host is unusable outside the network, and
 * one signed against a browser-facing host is unusable by the worker. Each is
 * used by its own S3 client — see `StorageService`.
 */
export default registerAs('storage', () => ({
  /** Internal endpoint — server-side calls and the worker's presigned reads. */
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  /** Endpoint baked into URLs handed to external clients. */
  publicEndpoint:
    process.env.S3_PUBLIC_ENDPOINT ??
    process.env.S3_ENDPOINT ??
    'http://minio:9000',
  /** Arbitrary for MinIO, but the SigV4 signer requires a value. */
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  /** Mandatory for MinIO — virtual-hosted addressing cannot resolve a container host. */
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',

  videosBucket: process.env.S3_VIDEOS_BUCKET ?? 'streamtube-videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET ?? 'streamtube-thumbnails',

  /** 64 MiB — 10 GiB lands at ~160 parts, under S3's 10,000-part cap. */
  uploadPartSizeBytes: Number(
    process.env.UPLOAD_PART_SIZE_BYTES ?? 64 * 1024 * 1024,
  ),
  /** 10 GiB ceiling declared by the phase. */
  uploadMaxSizeBytes: Number(
    process.env.UPLOAD_MAX_SIZE_BYTES ?? 10 * 1024 * 1024 * 1024,
  ),

  /** TTLs in seconds, fixed by TD-02 / TD-08 / TD-06 respectively. */
  uploadUrlTtlSeconds: Number(process.env.UPLOAD_URL_TTL_SECONDS ?? 3600),
  deliveryUrlTtlSeconds: Number(process.env.DELIVERY_URL_TTL_SECONDS ?? 300),
  workerUrlTtlSeconds: Number(process.env.WORKER_URL_TTL_SECONDS ?? 7200),
}));

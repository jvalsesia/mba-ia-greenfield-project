import { S3Client } from '@aws-sdk/client-s3';
import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

/**
 * Client used for every server-side call — create/complete/abort multipart,
 * put thumbnail, head object, bucket bootstrap — and for presigning the URL
 * the worker feeds to FFmpeg. Addressed at the in-network endpoint.
 */
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');

/**
 * Client used *only* to presign URLs handed to external clients.
 *
 * A separate client is not redundancy. SigV4 signs the `Host` header, so the
 * endpoint cannot be substituted after signing: a URL signed against the
 * internal Compose host is unusable outside the network, and one signed
 * against a browser-facing host is unusable by the worker. Each consumer gets
 * a URL signed for the host it can actually reach.
 */
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

function buildClient(
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    // Mandatory for MinIO. The SDK defaults to virtual-hosted addressing
    // (https://<bucket>.<host>/<key>), which cannot resolve against a
    // container hostname — every request would fail DNS resolution.
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export const s3InternalClientProvider: Provider = {
  provide: S3_INTERNAL_CLIENT,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>) =>
    buildClient(config, config.endpoint),
};

export const s3PublicClientProvider: Provider = {
  provide: S3_PUBLIC_CLIENT,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>) =>
    buildClient(config, config.publicEndpoint),
};
